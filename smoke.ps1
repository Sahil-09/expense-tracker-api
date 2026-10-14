$base = "http://127.0.0.1:3999"
$pass = 0; $fail = 0

function Check($name, $got, $want) {
  if ("$got" -eq "$want") { $script:pass++; Write-Host "  PASS  $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  FAIL  $name  got='$got' want='$want'" -ForegroundColor Red }
}

function StatusOf($sb) { try { & $sb | Out-Null; 200 } catch { [int]$_.Exception.Response.StatusCode } }

Write-Host "`n1. health is public and says nothing else" -ForegroundColor Cyan
$h = Invoke-RestMethod "$base/health"
Check "body" ($h | ConvertTo-Json -Compress) '{"status":"ok"}'

Write-Host "`n2. login issues a token per device" -ForegroundColor Cyan
$login = { param($id, $name, $pw, $mail = 'smoke@example.com')
  Invoke-RestMethod "$base/auth/login" -Method Post -ContentType 'application/json' -Body (@{
    email=$mail; password=$pw; deviceId=$id; deviceName=$name; platform='android'
  } | ConvertTo-Json)
}
$a = & $login 'phone-a' 'Pixel' 'smoke-password'
$b = & $login 'phone-b' 'Tablet' 'smoke-password'
Check "device a id" $a.deviceId 'phone-a'
Check "device b id" $b.deviceId 'phone-b'
Check "wrong password rejected" (StatusOf { & $login 'phone-a' 'Pixel' 'nope' }) 401

$authA = @{ authorization = "Bearer $($a.accessToken)" }
$authB = @{ authorization = "Bearer $($b.accessToken)" }

Write-Host "`n3. an expense pushed by phone-a reaches phone-b and nobody" -ForegroundColor Cyan
$expense = @{
  clientId='11111111-1111-4111-8111-111111111111'; amountPaise=14900; merchant='Zepto'
  category='Groceries'; txnAt=1760000000000; note=$null
  rawSms='Zepto Rs.149.00 debited'; dedupeKey='zepto rs.149.00|fri oct 10 2026'
  source='android-live'; isExpense=$true; isDue=$false
}
$r1 = Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authA `
  -Body (@{ deviceId='phone-a'; cursor=$null; expenses=@($expense) } | ConvertTo-Json -Depth 5)
Check "no echo to pusher" $r1.expenses.Count 0

$r2 = Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authB `
  -Body (@{ deviceId='phone-b'; cursor=$null } | ConvertTo-Json)
Check "phone-b rows" $r2.expenses.Count 1
Check "phone-b merchant" $r2.expenses[0].merchant 'Zepto'
Check "raw SMS carried" $r2.expenses[0].rawSms 'Zepto Rs.149.00 debited'

Write-Host "`n4. the cursor stops re-delivering" -ForegroundColor Cyan
$r3 = Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authB `
  -Body (@{ deviceId='phone-b'; cursor=$r2.cursor } | ConvertTo-Json)
Check "rows after cursor" $r3.expenses.Count 0

Write-Host "`n5. the same SMS on two devices collapses to one row" -ForegroundColor Cyan
$dup = $expense.Clone(); $dup.clientId = '22222222-2222-4222-8222-222222222222'
$r4 = Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authB `
  -Body (@{ deviceId='phone-b'; cursor=$r2.cursor; expenses=@($dup) } | ConvertTo-Json -Depth 5)
Check "duplicate reported" ($r4.duplicates.'22222222-2222-4222-8222-222222222222') '11111111-1111-4111-8111-111111111111'

Write-Host "`n6. a reinstall (no cursor) gets its own history back" -ForegroundColor Cyan
$r5 = Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authA `
  -Body (@{ deviceId='phone-a'; cursor=$null } | ConvertTo-Json)
Check "rows returned" $r5.expenses.Count 1

Write-Host "`n7. the server owns the clock" -ForegroundColor Cyan
$bad = $expense.Clone(); $bad.updatedAt = 1
Check "phone updatedAt rejected" (StatusOf { Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authA -Body (@{ deviceId='phone-a'; expenses=@($bad) } | ConvertTo-Json -Depth 5) }) 400

Write-Host "`n8. budgets and exclusions sync" -ForegroundColor Cyan
Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authA `
  -Body (@{ deviceId='phone-a'; budgets=@(@{ category='Groceries'; monthlyPaise=500000 }); exclusions=@(@{ merchant='swiggy' }) } | ConvertTo-Json -Depth 5) | Out-Null
$r6 = Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authB `
  -Body (@{ deviceId='phone-b'; cursor=$null } | ConvertTo-Json)
Check "budget" $r6.budgets[0].monthlyPaise 500000
Check "exclusion" $r6.exclusions[0].merchant 'swiggy'

Write-Host "`n9. delete travels as a tombstone" -ForegroundColor Cyan
$del = $expense.Clone(); $del.deleted = $true
Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authA `
  -Body (@{ deviceId='phone-a'; expenses=@($del) } | ConvertTo-Json -Depth 5) | Out-Null
$r7 = Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' -Headers $authB `
  -Body (@{ deviceId='phone-b'; cursor=$null } | ConvertTo-Json)
Check "deletedAt present" ($r7.expenses[0].deletedAt -is [long] -or $r7.expenses[0].deletedAt -is [int] -or $r7.expenses[0].deletedAt -gt 0) 'True'

Write-Host "`n10. refresh rotates, logout revokes" -ForegroundColor Cyan
$r8 = Invoke-RestMethod "$base/auth/refresh" -Method Post -ContentType 'application/json' -Body (@{ refreshToken=$a.refreshToken } | ConvertTo-Json)
Check "token rotated" ($r8.refreshToken -ne $a.refreshToken) 'True'
Check "old token dead" (StatusOf { Invoke-RestMethod "$base/auth/refresh" -Method Post -ContentType 'application/json' -Body (@{ refreshToken=$a.refreshToken } | ConvertTo-Json) }) 401
Invoke-RestMethod "$base/auth/logout" -Method Post -ContentType 'application/json' -Body (@{ refreshToken=$r8.refreshToken } | ConvertTo-Json) | Out-Null
Check "logged out" (StatusOf { Invoke-RestMethod "$base/auth/refresh" -Method Post -ContentType 'application/json' -Body (@{ refreshToken=$r8.refreshToken } | ConvertTo-Json) }) 401

Write-Host "`n11. one account cannot read another's data" -ForegroundColor Cyan
# A genuinely different account. phone-b is the SAME user as phone-a above, so it is
# supposed to see phone-a's row - using it here would prove nothing.
$other = & $login 'phone-z' 'Other phone' 'other-password' 'other@example.com'
$otherBody = Invoke-RestMethod "$base/sync" -Method Post -ContentType 'application/json' `
  -Headers @{ authorization = "Bearer $($other.accessToken)" } `
  -Body (@{ deviceId='phone-z'; cursor=$null } | ConvertTo-Json)
Check "other account sees nothing" $otherBody.expenses.Count 0

Write-Host "`n$pass passed, $fail failed" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
exit $fail