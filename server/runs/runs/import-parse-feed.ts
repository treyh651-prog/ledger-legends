/**
 * IMPORT-PARSE-FEED. Turn an uploaded structured file into staged rows.
 *
 * Spec: docs/05-decisions.md Part 3 decision D2, and docs/02-run-specifications.md
 * Module 3. The rules this run exists to hold:
 *
 *   1. Accepted formats are OFX, QFX, QBO, CAMT.053, CSV and XLSX. There is no
 *      statement parser for PDF, and there will not be one. A file that is
 *      really a PDF is rejected even when it arrives under a CSV name.
 *   2. CSV and XLSX are read through a stored, versioned column mapping profile.
 *      The incoming header row must match the stored header fingerprint exactly.
 *      On any difference the import stops and asks. It never guesses a shifted
 *      column, because a shifted column silently books amounts to the wrong
 *      sign or the wrong date and nothing downstream can detect that.
 *   3. Dedup runs here, before the coding cascade sees anything. Where the feed
 *      carries a bank supplied unique id, that id is the key and a repeat is
 *      rejected outright. Where it does not, a row matching an already posted
 *      register row on account, date, amount and normalized description is held
 *      for review rather than committed.
 *   4. Nothing here reaches the ledger. Parsing writes a batch and its staged
 *      rows and stops. IMPORT-COMMIT-BATCH is the run that commits them.
 *
 * Posting: No. writesLedger is false and no open period is required, because a
 * staged row is a proposal about the past, not an entry.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  isRowInsert,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { derivedId, scopeHashFor, sha256Hex } from "../ids";
import { revertFieldWrite } from "../undo";
import type { ImportBatchRow, MappingProfileRow, StagedRowRow } from "../tables";

/** Version of the descriptor normalization in force, stamped on staged rows. */
export const DESCRIPTOR_NORMALIZATION_VERSION = 1;

/** Formats that carry a bank supplied unique id in the file itself. */
export const BANK_ID_FORMATS = ["ofx", "qfx", "qbo"] as const;

/** Formats read through a stored column mapping profile. */
export const MAPPED_FORMATS = ["csv", "xlsx"] as const;

export const PARSE_ERROR_CODES = {
  unknownBankAccount: "UNKNOWN_BANK_ACCOUNT",
  pdfNotSupported: "PDF_NOT_SUPPORTED",
  formatNotImplemented: "FORMAT_NOT_IMPLEMENTED",
  missingPayload: "MISSING_PAYLOAD",
  missingMappingProfile: "MISSING_MAPPING_PROFILE",
  headerMismatch: "HEADER_FINGERPRINT_MISMATCH",
  emptyFeed: "EMPTY_FEED",
  unsupportedDateFormat: "UNSUPPORTED_DATE_FORMAT",
  profileIncomplete: "MAPPING_PROFILE_INCOMPLETE",
} as const;

export const ROW_ERROR_CODES = {
  badDate: "ROW_BAD_DATE",
  badAmount: "ROW_BAD_AMOUNT",
  zeroAmount: "ROW_ZERO_AMOUNT",
  missingDescription: "ROW_MISSING_DESCRIPTION",
} as const;

export const parseFeedScopeSchema = z.object({
  clientId: z.string().min(1),
  bankAccountId: z.string().min(1),
  /** Operator supplied batch name. It shows up in the reversal dialog. */
  batchName: z.string().min(1),
  institutionName: z.string().min(1),
  /** No pdf member. A format that cannot be parsed is not offered. */
  sourceFormat: z.enum(["ofx", "qfx", "qbo", "camt053", "csv", "xlsx"]),
  /** Text payload for the tagged and delimited formats. */
  fileText: z.string().nullable().default(null),
  /**
   * Cell grid for XLSX. The workbook is unzipped and flattened at the upload
   * boundary, so this run never depends on a spreadsheet library.
   */
  grid: z.array(z.array(z.string())).nullable().default(null),
  sourceDocumentId: z.string().nullable().default(null),
});

export type ParseFeedScope = z.infer<typeof parseFeedScopeSchema>;

/** One row as the parser understood it, before dedup runs. */
export interface ParsedFeedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  postedOn: string | null;
  description: string | null;
  amountCents: bigint | null;
  bankTransactionId: string | null;
  checkNumber: string | null;
  bankCode: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Descriptor normalization. Case folded, punctuation dropped, whitespace
 * collapsed, trailing store and terminal numbers dropped. This is the value the
 * no bank id dedup test compares on, so it has to be a pure function of the
 * text and it has to be versioned.
 */
export function normalizeDescriptor(text: string): string {
  const folded = text
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return folded.slice(0, 120);
}

/**
 * The header fingerprint. Cells are trimmed and case folded, then joined with a
 * pipe and hashed. Trimming and folding are deliberate: a bank that changes
 * "Date" to "date " has not changed the file shape. Anything more than that,
 * including a reordered or inserted column, changes the fingerprint and stops
 * the import.
 */
export function headerFingerprintOf(cells: readonly string[]): string {
  return sha256Hex(cells.map((c) => c.trim().toUpperCase()).join("|"));
}

/** RFC 4180 style splitter. Quoted fields may contain commas and doubled quotes. */
export function splitCsvLine(line: string, delimiter = ","): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(field);
      field = "";
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}

export function parseCsvGrid(text: string, delimiter = ","): string[][] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => splitCsvLine(line, delimiter));
}

/** Money to signed integer cents. Never floating point, never rounded twice. */
export function parseAmountCents(raw: string): bigint | null {
  let text = raw.trim();
  if (text.length === 0) return null;
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[$\s,]/g, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents =
    BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  return negative ? -cents : cents;
}

/**
 * Dates. Only the formats a mapping profile is allowed to name are understood,
 * and an unknown format is a run level error rather than a guess. A guessed
 * DD/MM against MM/DD moves half a year of transactions.
 */
export function parseFeedDate(raw: string, format: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const digits = text.replace(/[^\d]/g, "");
  const iso = (y: string, m: string, d: string): string | null => {
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (year < 1900 || year > 2200) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    const padded = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const probe = new Date(`${padded}T00:00:00.000Z`);
    if (Number.isNaN(probe.getTime())) return null;
    if (probe.toISOString().slice(0, 10) !== padded) return null;
    return padded;
  };
  switch (format) {
    case "YYYY-MM-DD":
    case "YYYYMMDD": {
      if (digits.length < 8) return null;
      return iso(digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8));
    }
    case "MM/DD/YYYY": {
      if (digits.length < 8) return null;
      return iso(digits.slice(4, 8), digits.slice(0, 2), digits.slice(2, 4));
    }
    case "DD/MM/YYYY": {
      if (digits.length < 8) return null;
      return iso(digits.slice(4, 8), digits.slice(2, 4), digits.slice(0, 2));
    }
    default:
      return null;
  }
}

export const SUPPORTED_DATE_FORMATS = [
  "YYYY-MM-DD",
  "YYYYMMDD",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
] as const;

function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  if (!match) return null;
  const value = match[1].trim();
  return value.length === 0 ? null : value;
}

/**
 * OFX, QFX and QBO all carry the same STMTTRN aggregate, so one reader covers
 * the three. The reader is tag scoped rather than line scoped, because banks
 * disagree about whether the closing tags are present at all.
 */
export function parseOfx(text: string): ParsedFeedRow[] {
  const rows: ParsedFeedRow[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  blocks.forEach((chunk, index) => {
    const block = chunk.split(/<\/STMTTRN>/i)[0];
    const rowNumber = index + 1;
    const rawDate = tagValue(block, "DTPOSTED");
    const rawAmount = tagValue(block, "TRNAMT");
    const name = tagValue(block, "NAME");
    const memo = tagValue(block, "MEMO");
    const description = name && memo ? `${name} ${memo}` : (name ?? memo);
    const postedOn = rawDate ? parseFeedDate(rawDate, "YYYYMMDD") : null;
    const amountCents = rawAmount ? parseAmountCents(rawAmount) : null;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    if (postedOn === null) {
      errorCode = ROW_ERROR_CODES.badDate;
      errorMessage = `DTPOSTED ${String(rawDate)} is not a date`;
    } else if (amountCents === null) {
      errorCode = ROW_ERROR_CODES.badAmount;
      errorMessage = `TRNAMT ${String(rawAmount)} is not an amount`;
    } else if (amountCents === BigInt(0)) {
      errorCode = ROW_ERROR_CODES.zeroAmount;
      errorMessage = "a zero amount is not a transaction";
    } else if (description === null) {
      errorCode = ROW_ERROR_CODES.missingDescription;
      errorMessage = "neither NAME nor MEMO is present";
    }
    rows.push({
      rowNumber,
      raw: {
        trnType: tagValue(block, "TRNTYPE"),
        dtPosted: rawDate,
        trnAmt: rawAmount,
        fitId: tagValue(block, "FITID"),
        name,
        memo,
        checkNum: tagValue(block, "CHECKNUM"),
      },
      postedOn,
      description,
      amountCents,
      bankTransactionId: tagValue(block, "FITID"),
      checkNumber: tagValue(block, "CHECKNUM"),
      bankCode: tagValue(block, "TRNTYPE"),
      errorCode,
      errorMessage,
    });
  });
  return rows;
}

function cellAt(
  header: readonly string[],
  row: readonly string[],
  column: string | null,
): string | null {
  if (!column) return null;
  const wanted = column.trim().toUpperCase();
  const index = header.findIndex((h) => h.trim().toUpperCase() === wanted);
  if (index < 0) return null;
  const value = row[index];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The mapped path. Called only after the header fingerprint matched, so every
 * named column is known to be where the profile says it is.
 */
export function parseMappedGrid(
  grid: readonly string[][],
  profile: MappingProfileRow,
): ParsedFeedRow[] {
  const headerIndex = Math.max(0, profile.headerRowNumber - 1);
  const header = grid[headerIndex] ?? [];
  const body = grid.slice(headerIndex + 1 + profile.skipRows);
  const rows: ParsedFeedRow[] = [];
  body.forEach((cells, index) => {
    const rowNumber = index + 1;
    const raw: Record<string, unknown> = {};
    header.forEach((name, i) => {
      raw[name.trim()] = cells[i] ?? null;
    });
    const rawDate = cellAt(header, cells, profile.dateColumn);
    const description = cellAt(header, cells, profile.descriptionColumn);
    const postedOn = rawDate ? parseFeedDate(rawDate, profile.dateFormat) : null;

    let amountCents: bigint | null = null;
    if (profile.signConvention === "separate_columns") {
      const debit = cellAt(header, cells, profile.debitColumn);
      const credit = cellAt(header, cells, profile.creditColumn);
      const debitCents = debit ? parseAmountCents(debit) : null;
      const creditCents = credit ? parseAmountCents(credit) : null;
      if (debitCents !== null && debitCents !== BigInt(0)) {
        // A debit column entry is money leaving the account, so it is negative
        // in the register no matter how the bank presented it.
        amountCents = -absCents(debitCents);
      } else if (creditCents !== null && creditCents !== BigInt(0)) {
        amountCents = absCents(creditCents);
      } else if (debitCents !== null || creditCents !== null) {
        amountCents = BigInt(0);
      }
    } else {
      const signed = cellAt(header, cells, profile.amountColumn);
      const value = signed ? parseAmountCents(signed) : null;
      if (value !== null) {
        amountCents =
          profile.signConvention === "debit_positive" ? -value : value;
      }
    }

    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    if (postedOn === null) {
      errorCode = ROW_ERROR_CODES.badDate;
      errorMessage = `column ${profile.dateColumn} value ${String(rawDate)} is not a ${profile.dateFormat} date`;
    } else if (amountCents === null) {
      errorCode = ROW_ERROR_CODES.badAmount;
      errorMessage = "no amount could be read from the mapped columns";
    } else if (amountCents === BigInt(0)) {
      errorCode = ROW_ERROR_CODES.zeroAmount;
      errorMessage = "a zero amount is not a transaction";
    } else if (description === null) {
      errorCode = ROW_ERROR_CODES.missingDescription;
      errorMessage = `column ${profile.descriptionColumn} is empty`;
    }

    rows.push({
      rowNumber,
      raw,
      postedOn,
      description,
      amountCents,
      bankTransactionId: cellAt(header, cells, profile.bankIdColumn),
      checkNumber: cellAt(header, cells, profile.checkNumberColumn),
      bankCode: cellAt(header, cells, profile.bankCodeColumn),
      errorCode,
      errorMessage,
    });
  });
  return rows;
}

function absCents(value: bigint): bigint {
  return value < BigInt(0) ? -value : value;
}

/** Stable batch id. Same client, account, name and bytes give the same id. */
export function batchIdFor(scope: ParseFeedScope): Ulid {
  const payload = scope.fileText ?? JSON.stringify(scope.grid ?? []);
  const seed = [
    scope.clientId,
    scope.bankAccountId,
    scope.batchName,
    scope.sourceFormat,
    sha256Hex(payload),
  ].join(":");
  return derivedId(seed, "import_batch", 0);
}

function looksLikePdf(text: string | null): boolean {
  if (!text) return false;
  return text.trimStart().startsWith("%PDF");
}

export const importParseFeed: Run<ParseFeedScope, Proposal> = {
  type: "IMPORT-PARSE-FEED",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.bankAccountId}`,
  scopeSchema: parseFeedScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ParseFeedScope>> {
    const tx = requireTx(ctx);
    const accounts = await tx.query("bank_accounts_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const profiles = MAPPED_FORMATS.some((f) => f === scope.sourceFormat)
      ? await tx.query("active_mapping_profile", {
          firmId: ctx.firmId,
          clientId: scope.clientId,
          institutionName: scope.institutionName,
          fileFormat: scope.sourceFormat,
        })
      : [];

    const batchId = batchIdFor(scope);
    const runDay = ctx.now.toISOString().slice(0, 10);
    // The batch is the one candidate. Staged row ids are not known until the
    // file is read, and a candidate list that changed with the file contents
    // would make the scope hash useless for deduplicating a repeated apply.
    const candidateIds = [batchId];
    const versions = [
      { id: "IMPORT-PARSE-FEED", version: 1 },
      {
        id: "DESCRIPTOR-NORMALIZATION",
        version: DESCRIPTOR_NORMALIZATION_VERSION,
      },
      ...accounts
        .filter((a) => a.id === scope.bankAccountId)
        .map((a) => ({ id: a.id, version: 1 })),
      ...profiles.map((p) => ({ id: p.id, version: p.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      // Parsing has no accounting period. The dates in the file are not known
      // until propose reads it, so the run day stands in for both ends.
      periodStart: runDay,
      periodEnd: runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const skips: Skip[] = [];
    const batchId = batchIdFor(scope);

    const refuse = (): RunResult<Proposal> =>
      makeResult<Proposal>(1, [], skips, errors, BigInt(0));

    const accounts = await tx.query("bank_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const account = accounts.find((a) => a.id === scope.bankAccountId);
    if (!account) {
      errors.push({
        rowId: batchId,
        code: PARSE_ERROR_CODES.unknownBankAccount,
        message: `bank account ${scope.bankAccountId} does not belong to client ${frozen.clientId}`,
        retryable: false,
      });
      return refuse();
    }

    // A PDF that arrived under a CSV name. Doc 05 Part 3 is absolute on this
    // point, so the check is on the bytes and not on the file name.
    if (looksLikePdf(scope.fileText)) {
      errors.push({
        rowId: batchId,
        code: PARSE_ERROR_CODES.pdfNotSupported,
        message:
          "the payload is a PDF. There is no statement parser for PDF and there will not be one. Ask for OFX, QFX, QBO or CSV",
        retryable: false,
      });
      return refuse();
    }

    let parsed: ParsedFeedRow[] = [];
    let profile: MappingProfileRow | null = null;

    if (BANK_ID_FORMATS.some((f) => f === scope.sourceFormat)) {
      if (scope.fileText === null) {
        errors.push({
          rowId: batchId,
          code: PARSE_ERROR_CODES.missingPayload,
          message: `format ${scope.sourceFormat} needs fileText`,
          retryable: false,
        });
        return refuse();
      }
      parsed = parseOfx(scope.fileText);
    } else if (scope.sourceFormat === "camt053") {
      // Accepted by the decision record, not yet implemented here. A named
      // refusal is honest. Pretending to parse it would be worse.
      errors.push({
        rowId: batchId,
        code: PARSE_ERROR_CODES.formatNotImplemented,
        message: "CAMT.053 parsing is not implemented in this run version",
        retryable: false,
      });
      return refuse();
    } else {
      const profiles = await tx.query("active_mapping_profile", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        institutionName: scope.institutionName,
        fileFormat: scope.sourceFormat,
      });
      if (profiles.length === 0) {
        errors.push({
          rowId: batchId,
          code: PARSE_ERROR_CODES.missingMappingProfile,
          message: `no active ${scope.sourceFormat} mapping profile for institution ${scope.institutionName}`,
          retryable: false,
        });
        return refuse();
      }
      profile = profiles[0];

      if (!SUPPORTED_DATE_FORMATS.some((f) => f === profile?.dateFormat)) {
        errors.push({
          rowId: batchId,
          code: PARSE_ERROR_CODES.unsupportedDateFormat,
          message: `mapping profile ${profile.id} names date format ${profile.dateFormat}, which this run version cannot read`,
          retryable: false,
        });
        return refuse();
      }
      if (
        profile.signConvention === "separate_columns"
          ? !profile.debitColumn || !profile.creditColumn
          : !profile.amountColumn
      ) {
        errors.push({
          rowId: batchId,
          code: PARSE_ERROR_CODES.profileIncomplete,
          message: `mapping profile ${profile.id} names sign convention ${profile.signConvention} without the columns it needs`,
          retryable: false,
        });
        return refuse();
      }

      const grid =
        scope.sourceFormat === "csv"
          ? scope.fileText === null
            ? null
            : parseCsvGrid(scope.fileText)
          : scope.grid;
      if (grid === null) {
        errors.push({
          rowId: batchId,
          code: PARSE_ERROR_CODES.missingPayload,
          message: `format ${scope.sourceFormat} needs ${scope.sourceFormat === "csv" ? "fileText" : "grid"}`,
          retryable: false,
        });
        return refuse();
      }

      const headerIndex = Math.max(0, profile.headerRowNumber - 1);
      const header = grid[headerIndex];
      const fingerprint = headerFingerprintOf(header ?? []);
      if (fingerprint !== profile.headerFingerprint) {
        // The whole point of the fingerprint. Stop and ask. A shifted or
        // renamed column is reported with both fingerprints and both header
        // rows so a person can see what moved.
        errors.push({
          rowId: batchId,
          code: PARSE_ERROR_CODES.headerMismatch,
          message: `header row does not match mapping profile ${profile.id} version ${String(profile.version)}. expected fingerprint ${profile.headerFingerprint}, found ${fingerprint}, header read as ${JSON.stringify(header ?? [])}. the import stopped and did not guess a shifted column`,
          retryable: false,
        });
        return refuse();
      }

      parsed = parseMappedGrid(grid, profile);
    }

    if (parsed.length === 0) {
      errors.push({
        rowId: batchId,
        code: PARSE_ERROR_CODES.emptyFeed,
        message: "the file parsed cleanly and contained no transactions",
        retryable: false,
      });
      return refuse();
    }

    const dates = parsed
      .map((r) => r.postedOn)
      .filter((d): d is string => d !== null)
      .sort();
    const earliest = dates[0] ?? null;
    const latest = dates[dates.length - 1] ?? null;

    const feedBankIds = parsed
      .map((r) => r.bankTransactionId)
      .filter((id): id is string => id !== null);

    const byBankId =
      feedBankIds.length === 0
        ? []
        : await tx.query("transactions_by_bank_ids", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            bankAccountId: scope.bankAccountId,
            bankTransactionIds: feedBankIds,
          });
    const postedByBankId = new Map<string, Ulid>();
    for (const row of byBankId) {
      if (row.bankTransactionId) postedByBankId.set(row.bankTransactionId, row.id);
    }

    // The second dedup test needs the posted rows around the same dates, with a
    // week of slack either side so a row posted slightly outside the file
    // window is still visible to the comparison.
    const window =
      earliest === null || latest === null
        ? []
        : await tx.query("transactions_for_account_window", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            bankAccountId: scope.bankAccountId,
            from: shiftDays(earliest, -7),
            to: shiftDays(latest, 7),
          });
    const softKeyed = new Map<string, Ulid>();
    for (const row of window) {
      if (row.status !== "active") continue;
      softKeyed.set(
        softKey(
          row.accountNumber,
          row.postedDate,
          row.amountCents,
          row.normalizedVendor,
        ),
        row.id,
      );
    }

    const proposals: Proposal[] = [];
    const stagedRows: StagedRowRow[] = [];
    const seenInFile = new Set<string>();
    let accepted = 0;
    let rejected = 0;
    let held = 0;
    let net = BigInt(0);

    for (const row of parsed) {
      const normalized =
        row.description === null ? null : normalizeDescriptor(row.description);
      let dedupState: StagedRowRow["dedupState"] = "unique";
      let reviewState: StagedRowRow["reviewState"] = "none";
      let duplicateOf: Ulid | null = null;
      let errorCode = row.errorCode;
      let errorMessage = row.errorMessage;

      if (errorCode !== null) {
        // A row the parser could not read is rejected on its own terms. It is
        // never quietly dropped, because the batch counts have to add up.
        reviewState = "rejected";
        rejected += 1;
      } else if (row.bankTransactionId !== null) {
        const already = postedByBankId.get(row.bankTransactionId);
        if (already) {
          dedupState = "rejected_duplicate";
          duplicateOf = already;
          rejected += 1;
        } else if (seenInFile.has(row.bankTransactionId)) {
          dedupState = "rejected_duplicate";
          errorCode = "ROW_REPEATED_IN_FILE";
          errorMessage = `bank supplied id ${row.bankTransactionId} appears twice in the same file`;
          rejected += 1;
        } else {
          seenInFile.add(row.bankTransactionId);
          accepted += 1;
        }
      } else {
        const key = softKey(
          account.accountNumber,
          row.postedOn ?? "",
          row.amountCents ?? BigInt(0),
          normalized ?? "",
        );
        const match = softKeyed.get(key);
        if (match) {
          // No bank supplied id, so this is a probable repeat and not a proven
          // one. Doc 05 Part 3 holds it for a person instead of guessing.
          dedupState = "held_for_review";
          reviewState = "pending";
          duplicateOf = match;
          held += 1;
        } else {
          accepted += 1;
        }
      }

      if (dedupState === "unique" && errorCode === null) {
        net += row.amountCents ?? BigInt(0);
      }

      const stagedId = derivedId(batchId, "staged_row", row.rowNumber);
      const staged: StagedRowRow = {
        id: stagedId,
        batchId,
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        rowNumber: row.rowNumber,
        rawRow: row.raw,
        postedOn: row.postedOn,
        description: row.description,
        normalizedDescription: normalized,
        amountCents: row.amountCents,
        currency: profile ? profile.currency : "USD",
        accountNumber: account.accountNumber,
        bankAccountId: account.id,
        bankTransactionId: row.bankTransactionId,
        checkNumber: row.checkNumber,
        bankCode: row.bankCode,
        dedupState,
        duplicateOfTransactionId: duplicateOf,
        reviewState,
        committedTransactionId: null,
        committedEntryId: null,
        errorCode,
        errorMessage,
        version: 1,
      };
      stagedRows.push(staged);
    }

    const batch: ImportBatchRow = {
      id: batchId,
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      name: scope.batchName,
      sourceFormat: scope.sourceFormat,
      bankAccountId: account.id,
      accountNumber: account.accountNumber,
      mappingProfileId: profile ? profile.id : null,
      mappingProfileVersion: profile ? profile.version : null,
      // Held rows put the batch in review. Everything else is parsed and ready.
      status: held > 0 ? "in_review" : "parsed",
      rejectReason: null,
      rowCount: parsed.length,
      acceptedCount: accepted,
      rejectedCount: rejected,
      heldCount: held,
      netCents: net,
      // Substituted by the writer. See RUN_ID_PLACEHOLDER.
      parsedRunId: RUN_ID_PLACEHOLDER,
      committedRunId: null,
      committedAt: null,
      reversedRunId: null,
      reversedAt: null,
      reversalBlocked: false,
      createdAt: NOW_PLACEHOLDER,
      version: 1,
    };

    proposals.push(insertOf("import_batches", batchId, batch));
    for (const staged of stagedRows) {
      proposals.push(insertOf("staged_rows", staged.id, staged));
    }

    // Net is reported but no money moved. Parsing does not touch the ledger.
    return makeResult<Proposal>(1, proposals, skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "IMPORT-PARSE-FEED",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) {
        plan.push(revertFieldWrite(p));
        continue;
      }
      if (!isRowInsert(p)) continue;
      if (p.table !== "import_batches") continue;
      // Staged rows are evidence of what the file said, so undo does not erase
      // them. It marks the batch rejected, which takes it out of every commit
      // path. Rows nobody committed are inert once the batch is closed.
      plan.push({
        kind: "field_write",
        table: "import_batches",
        rowId: p.rowId,
        before: { status: "parsed", rejectReason: null },
        after: {
          status: "rejected",
          rejectReason: "parse_undone",
        },
        provenance: { cascadeLevel: 0 },
      });
    }
    return plan;
  },
};

function insertOf(
  table: string,
  rowId: Ulid,
  row: object,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table,
    rowId,
    row: row as Record<string, unknown>,
    // Level 0. Import provenance, before the coding cascade has an opinion.
    provenance: { cascadeLevel: 0 },
  };
}

/** The no bank id dedup key: account, date, amount, normalized description. */
export function softKey(
  accountNumber: string,
  postedOn: string,
  amountCents: bigint,
  normalizedDescription: string,
): string {
  return [
    accountNumber,
    postedOn,
    amountCents.toString(),
    normalizedDescription,
  ].join("|");
}

function shiftDays(day: string, delta: number): string {
  const base = new Date(`${day}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}
