# Verifies the exact mongo commands ops/backup.sh and ops/restore-test.sh use, since the
# bash scripts cannot run on Windows. Run from the repo root.
#
# Native commands (docker, mongosh) write failures to stderr, which $ErrorActionPreference
# 'Stop' would turn into a terminating error before an exit code is ever checked. Every
# verdict below comes from an exit code or an explicit throw.
$ErrorActionPreference = 'Continue'

# PowerShell strips the inner quotes out of a --eval argument, so all the JavaScript below
# avoids them: string literals use '' (an escaped single quote), never ".
$User = 'ettest'
$Pass = 'ettest-pass'
$Db = 'expense-tracker'

# mongosh --eval has no way to name a database on the command line, so the script selects
# it. Getting this wrong is silent: you get a `{}` count and a false pass.
$Ping = 'db.getSiblingDB(''expense-tracker'').adminCommand({ping:1})'
$CountsJs = 'const d=db.getSiblingDB(''expense-tracker'');const c={};d.getCollectionNames().sort().forEach(function(n){c[n]=d.getCollection(n).countDocuments();});print(JSON.stringify(c));'
$IndexesJs = 'const d=db.getSiblingDB(''expense-tracker'');const names=d.getCollectionNames();const out={};[''expenses'',''budgets'',''exclusions'',''devices''].forEach(function(n){out[n]=names.indexOf(n)<0?[]:d.getCollection(n).getIndexes().map(function(i){return JSON.stringify(i.key)+(i.unique?''!'':'''')}).sort();});print(JSON.stringify(out));'
$SeedJs = 'const d=db.getSiblingDB(''expense-tracker'');d.expenses.insertMany([{clientId:''a'',dedupeKey:''k1'',amountPaise:100},{clientId:''b'',dedupeKey:''k2'',amountPaise:200},{clientId:''c'',dedupeKey:''k3'',amountPaise:300}]);d.budgets.insertOne({category:''Groceries'',monthlyPaise:5000});d.users.insertOne({email:''a@b.c''});d.expenses.createIndex({clientId:1},{unique:true});d.expenses.createIndex({dedupeKey:1},{unique:true});print(''seeded'');'

function Cleanup-Old {
  docker rm -f et-live et-restore *>&1 | Out-Null
  docker volume rm et-live-vol et-restore-vol *>&1 | Out-Null
}
function Start-Mongo($Name, $Volume) {
  docker run -d --name $Name `
    -e MONGO_INITDB_ROOT_USERNAME=$User -e MONGO_INITDB_ROOT_PASSWORD=$Pass `
    -v "${Volume}:/data/db" mongo:8 *>&1 | Out-Null
}
function Wait-Mongo($Name) {
  for ($i = 0; $i -lt 90; $i++) {
    docker exec $Name mongosh --quiet -u $User -p $Pass --authenticationDatabase admin --eval $Ping *>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  throw "mongod for $Name never accepted credentials"
}
function Counts($Name) {
  $out = docker exec $Name mongosh --quiet -u $User -p $Pass --authenticationDatabase admin --eval $CountsJs
  ($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1).Trim()
}
function Indexes($Name) {
  $out = docker exec $Name mongosh --quiet -u $User -p $Pass --authenticationDatabase admin --eval $IndexesJs
  ($out | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1).Trim()
}

Cleanup-Old
Write-Host 'Starting two authenticated mongods' -ForegroundColor Cyan
Start-Mongo 'et-live' 'et-live-vol'
Start-Mongo 'et-restore' 'et-restore-vol'
Wait-Mongo 'et-live'
Wait-Mongo 'et-restore'
Write-Host 'auth works: ping succeeded with credentials, and the container is auth-enabled' -ForegroundColor Green

Write-Host "`nSeeding the live database" -ForegroundColor Cyan
docker exec et-live mongosh --quiet -u $User -p $Pass --authenticationDatabase admin --eval $SeedJs
$live = Counts 'et-live'
Write-Host "live:    $live"
if ($live -notmatch '"expenses":3') { throw "seed did not land (got $live) - a {} or unexpected count here would false-pass the restore check" }

Write-Host "`nBackup: mongodump --archive --gzip --db (the flags backup.sh uses)" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path backups | Out-Null
$Archive = 'backups/verify.archive.gz'
# cmd /c rather than PowerShell's >: PS re-encodes a binary stream and corrupts the gzip
# archive. Bash's > is byte-exact, which is what backup.sh relies on.
cmd /c "docker exec et-live mongodump --archive --gzip --quiet -u $User -p $Pass --authenticationDatabase admin --db $Db > $Archive"
if ($LASTEXITCODE -ne 0) { throw "mongodump exited $LASTEXITCODE" }
$size = (Get-Item $Archive).Length
Write-Host "dump is $size bytes"
if ($size -le 0) { throw 'mongodump wrote nothing - exactly the silent failure backup.sh guards against' }

Write-Host "`nRestore: gunzip, then mongorestore --archive --nsInclude from stdin (what restore-test.sh does)" -ForegroundColor Cyan
docker cp $Archive 'et-restore:/tmp/restore.archive.gz' | Out-Null
docker exec et-restore sh -c "gunzip -c /tmp/restore.archive.gz > /tmp/restore.archive && mongorestore --archive --drop -u '$User' -p '$Pass' --authenticationDatabase admin --nsInclude='$Db.*' < /tmp/restore.archive"
if ($LASTEXITCODE -ne 0) { throw "mongorestore exited $LASTEXITCODE" }
$restored = Counts 'et-restore'
Write-Host "restore: $restored"

Write-Host "`n--drop is idempotent: restoring twice must not double the rows" -ForegroundColor Cyan
docker exec et-restore sh -c "mongorestore --archive --drop -u '$User' -p '$Pass' --authenticationDatabase admin --nsInclude='$Db.*' < /tmp/restore.archive"
$twice = Counts 'et-restore'
$liveIdx = Indexes 'et-live'
$restoredIdx = Indexes 'et-restore'

Write-Host "`n================ RESULT ================"
$ok = $true
if ($live -eq $restored -and $restored -match '"expenses":3') { Write-Host "PASS  restore matches live: $restored" -ForegroundColor Green }
else { Write-Host "FAIL  live=$live restored=$restored" -ForegroundColor Red; $ok = $false }
if ($twice -eq $restored) { Write-Host "PASS  --drop is idempotent: $twice" -ForegroundColor Green }
else { Write-Host "FAIL  second restore doubled: $twice" -ForegroundColor Red; $ok = $false }
if ($liveIdx -eq $restoredIdx -and $liveIdx -match 'dedupeKey') { Write-Host "PASS  indexes survive the restore: $restoredIdx" -ForegroundColor Green }
else { Write-Host "FAIL  indexes differ  live=$liveIdx  restored=$restoredIdx" -ForegroundColor Red; $ok = $false }

# The check has to be able to fail, or it proves nothing.
Write-Host "`nNegative control: drop the unique index on the restore and re-compare" -ForegroundColor Cyan
docker exec et-restore mongosh --quiet -u $User -p $Pass --authenticationDatabase admin --eval 'const d=db.getSiblingDB(''expense-tracker'');d.expenses.dropIndex(''dedupeKey_1'');print(''dropped'');' | Out-Null
$brokenIdx = Indexes 'et-restore'
if ($brokenIdx -ne $liveIdx) { Write-Host 'PASS  a missing index is detected (the check is not vacuous)' -ForegroundColor Green }
else { Write-Host 'FAIL  the index check passed on a broken database - it is not actually checking' -ForegroundColor Red; $ok = $false }

Cleanup-Old
Remove-Item $Archive -Force
if ($ok) { Write-Host "`nAll backup/restore commands verified." -ForegroundColor Green; exit 0 }
exit 1