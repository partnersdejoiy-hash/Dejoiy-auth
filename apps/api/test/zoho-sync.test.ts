import { describe, expect, it } from "vitest";
import {
  normalizeDirection,
  pushEnabled,
  pullEnabled,
  computeRecordHash,
  sheetRecordValues,
  classifyFieldChange
} from "../src/services/zoho-sync.js";

describe("zoho sync field directions (Phase 4)", () => {
  it("normalizes valid directions and falls back to db_to_sheet for unknown values", () => {
    expect(normalizeDirection("never")).toBe("never");
    expect(normalizeDirection("db_to_sheet")).toBe("db_to_sheet");
    expect(normalizeDirection("sheet_to_db")).toBe("sheet_to_db");
    expect(normalizeDirection("bidirectional")).toBe("bidirectional");
    expect(normalizeDirection("garbage")).toBe("db_to_sheet");
    expect(normalizeDirection("")).toBe("db_to_sheet");
  });

  it("maps directions to push/pull capability", () => {
    expect(pushEnabled("db_to_sheet")).toBe(true);
    expect(pushEnabled("bidirectional")).toBe(true);
    expect(pushEnabled("sheet_to_db")).toBe(false);
    expect(pushEnabled("never")).toBe(false);

    expect(pullEnabled("sheet_to_db")).toBe(true);
    expect(pullEnabled("bidirectional")).toBe(true);
    expect(pullEnabled("db_to_sheet")).toBe(false);
    expect(pullEnabled("never")).toBe(false);
  });
});

describe("zoho sync record hashing", () => {
  it("is deterministic and order-insensitive", () => {
    const a = computeRecordHash({ "User ID": "DJY-000001", Status: "ACTIVE", Role: "a, b" });
    const b = computeRecordHash({ Role: "a, b", Status: "ACTIVE", "User ID": "DJY-000001" });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("treats a column cleared to empty as a change (not missing)", () => {
    const cleared = computeRecordHash({ Name: "" });
    const missing = computeRecordHash({});
    expect(cleared).not.toBe(missing);
    // And a value change is detected
    expect(computeRecordHash({ Status: "ACTIVE" })).not.toBe(computeRecordHash({ Status: "SUSPENDED" }));
  });

  it("extracts only the requested columns as strings", () => {
    const rec = {
      "User ID": "DJY-1",
      Status: "ACTIVE",
      "MFA Enabled": true,
      row_index: 3,
      Extra: "ignored"
    };
    const values = sheetRecordValues(rec, ["User ID", "Status", "MFA Enabled"]);
    expect(values).toEqual({ "User ID": "DJY-1", Status: "ACTIVE", "MFA Enabled": "true" });
    expect(values.Extra).toBeUndefined();
  });
});

describe("zoho sync conflict classification (Phase 5)", () => {
  it("noop when values match", () => {
    expect(classifyFieldChange({ dbValue: "ACTIVE", sheetValue: "ACTIVE", lastKnownSheetValue: "ACTIVE" })).toBe("noop");
  });

  it("applies when only the sheet changed since the last sync", () => {
    expect(classifyFieldChange({ dbValue: "ACTIVE", sheetValue: "SUSPENDED", lastKnownSheetValue: "ACTIVE" })).toBe("apply");
  });

  it("lets the DB win when only the DB changed since the last sync", () => {
    expect(classifyFieldChange({ dbValue: "BLOCKED", sheetValue: "ACTIVE", lastKnownSheetValue: "ACTIVE" })).toBe("db_wins");
  });

  it("flags a conflict when both sides changed", () => {
    expect(classifyFieldChange({ dbValue: "BLOCKED", sheetValue: "TERMINATED", lastKnownSheetValue: "ACTIVE" })).toBe("conflict");
  });
});
