import {
  IsArray,
  IsBoolean,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One changed expense, in the shape the phone holds it.
 *
 * Timestamps cross the wire as epoch milliseconds because the phone already stores `txn_at`
 * that way and converting on both ends would be a bug waiting to happen. There is no
 * `updatedAt` on the wire: the server stamps that itself, and using the phone's clock for
 * ordering is what makes two devices disagree.
 */
/**
 * category, dedupeKey and source are not required to be non-empty. A tombstone carries no
 * message text, so the phone sends blank strings for all three — and rejecting them meant
 * the whole sync came back 400 and *no delete ever reached the server*.
 */
export class ExpenseChange {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientId: string;

  @IsInt()
  amountPaise: number;

  @IsOptional()
  @IsString()
  merchant?: string | null;

  @IsString()
  category: string;

  @IsInt()
  txnAt: number;

  @IsOptional()
  @IsString()
  note?: string | null;

  @IsString()
  rawSms: string;

  @IsString()
  dedupeKey: string;

  @IsString()
  source: string;

  @IsBoolean()
  isExpense: boolean;

  @IsBoolean()
  isDue: boolean;

  /** Present means "delete this everywhere"; the row is kept as a tombstone. */
  @IsOptional()
  @IsBoolean()
  deleted?: boolean;
}

export class BudgetChange {
  @IsString()
  @IsNotEmpty()
  category: string;

  @IsInt()
  monthlyPaise: number;

  @IsOptional()
  @IsBoolean()
  deleted?: boolean;
}

export class ExclusionChange {
  @IsString()
  @IsNotEmpty()
  merchant: string;

  @IsOptional()
  @IsBoolean()
  deleted?: boolean;
}

export class SyncRequest {
  @IsString()
  @MaxLength(64)
  deviceId: string;

  /** Omitted or null on the very first sync, meaning "everything since the beginning". */
  @IsOptional()
  @IsISO8601()
  cursor?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpenseChange)
  expenses?: ExpenseChange[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BudgetChange)
  budgets?: BudgetChange[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExclusionChange)
  exclusions?: ExclusionChange[];
}

export type ExpenseRow = {
  clientId: string;
  amountPaise: number;
  merchant: string | null;
  category: string;
  txnAt: number;
  note: string | null;
  rawSms: string;
  dedupeKey: string;
  source: string;
  isExpense: boolean;
  isDue: boolean;
  /** Epoch ms of the delete, or null while the row is live. */
  deletedAt: number | null;
};

export type SyncResponse = {
  /** Pass straight back on the next call. */
  cursor: string;
  /** True when more rows remain, so the phone should immediately sync again. */
  hasMore: boolean;
  expenses: ExpenseRow[];
  budgets: {
    category: string;
    monthlyPaise: number;
    deletedAt: number | null;
  }[];
  exclusions: { merchant: string; deletedAt: number | null }[];
  /**
   * Client ids the server already holds under a different row, keyed by the client's own
   * id. The phone deletes these locally so a re-scan of the same SMS on two devices
   * collapses into one expense instead of two.
   */
  duplicates: Record<string, string>;
};
