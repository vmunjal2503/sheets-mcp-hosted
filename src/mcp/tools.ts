import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google, type sheets_v4, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

const ok = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text:
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const fail = (err: unknown) => {
  const e = err as { message?: string };
  return {
    isError: true,
    content: [{ type: "text" as const, text: e?.message ?? String(err) }],
  };
};

const call = async <T>(fn: () => Promise<T>) => {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
};

function parseA1(range: string): {
  tabName: string | undefined;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
} {
  const parts = range.split("!");
  const tabName = parts.length === 2 ? parts[0] : undefined;
  const a1 = parts.length === 2 ? parts[1]! : parts[0]!;
  const m = a1.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!m) {
    throw new Error(
      `Range must be A1 form like 'Sheet1!A1:G100' or 'A1:G100', got '${range}'`,
    );
  }
  const colIndex = (letters: string) =>
    letters
      .split("")
      .reduce((acc, c) => acc * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  return {
    tabName,
    startRowIndex: parseInt(m[2]!, 10) - 1,
    endRowIndex: parseInt(m[4]!, 10),
    startColumnIndex: colIndex(m[1]!),
    endColumnIndex: colIndex(m[3]!) + 1,
  };
}

async function resolveSheetId(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetNameOrId?: string | number,
): Promise<number> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const tabs = (meta.data.sheets || []).map((s) => s.properties!);
  if (sheetNameOrId === undefined || sheetNameOrId === null) {
    return tabs[0]!.sheetId!;
  }
  if (typeof sheetNameOrId === "number") return sheetNameOrId;
  const match = tabs.find((t) => t.title === sheetNameOrId);
  if (!match) {
    throw new Error(
      `Sheet tab "${sheetNameOrId}" not found. Available: ${tabs.map((t) => t.title).join(", ")}`,
    );
  }
  return match.sheetId!;
}

// Flexible A1 parser that also accepts open-ended ranges ("A:G", "P2:P") and
// single cells ("A1") in addition to full ranges ("A1:G100"). Missing bounds
// are left undefined (= unbounded in a Sheets GridRange).
function a1Flexible(range: string): {
  tabName: string | undefined;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
} {
  const parts = range.split("!");
  const tabName = parts.length === 2 ? parts[0] : undefined;
  const a1 = (parts.length === 2 ? parts[1]! : parts[0]!).toUpperCase();
  const colIndex = (letters: string) =>
    letters.split("").reduce((acc, c) => acc * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  const endpoint = (s: string) => {
    const mm = s.match(/^([A-Z]+)?(\d+)?$/);
    if (!mm || (!mm[1] && !mm[2])) return null;
    return {
      col: mm[1] ? colIndex(mm[1]) : undefined,
      row: mm[2] ? parseInt(mm[2], 10) : undefined,
    };
  };
  const [lhs, rhs] = a1.includes(":") ? a1.split(":") : [a1, a1];
  const L = endpoint(lhs!);
  const R = endpoint(rhs!);
  if (!L || !R) {
    throw new Error(
      `Range must be A1 form like 'Sheet1!A1:G100', 'P2:P' or 'A:G', got '${range}'`,
    );
  }
  return {
    tabName,
    startColumnIndex: L.col,
    endColumnIndex: R.col !== undefined ? R.col + 1 : undefined,
    startRowIndex: L.row !== undefined ? L.row - 1 : undefined,
    endRowIndex: R.row !== undefined ? R.row : undefined,
  };
}

// Resolve a full A1 range string into a Sheets GridRange (numeric sheetId +
// 0-indexed bounds), omitting any unbounded side.
async function gridRange(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  range: string,
) {
  const r = a1Flexible(range);
  const sheetId = await resolveSheetId(sheets, spreadsheetId, r.tabName);
  const gr: Record<string, number> = { sheetId };
  if (r.startRowIndex !== undefined) gr.startRowIndex = r.startRowIndex;
  if (r.endRowIndex !== undefined) gr.endRowIndex = r.endRowIndex;
  if (r.startColumnIndex !== undefined) gr.startColumnIndex = r.startColumnIndex;
  if (r.endColumnIndex !== undefined) gr.endColumnIndex = r.endColumnIndex;
  return gr;
}

export function registerTools(server: McpServer, auth: OAuth2Client) {
  const sheets = google.sheets({ version: "v4", auth });
  const drive: drive_v3.Drive = google.drive({ version: "v3", auth });

  // ── Discovery ──────────────────────────────────────────────────

  server.tool(
    "list_sheets",
    "Search Google Drive for spreadsheets by name (substring match). Returns id + title + last modified.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Optional name substring. If omitted, returns the 20 most recently modified spreadsheets.",
        ),
    },
    async ({ query }) =>
      call(async () => {
        let q = `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
        if (query) q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
        const res = await drive.files.list({
          q,
          pageSize: 20,
          orderBy: "modifiedTime desc",
          fields: "files(id,name,modifiedTime,owners(emailAddress))",
        });
        return res.data.files || [];
      }),
  );

  server.tool(
    "get_sheet_metadata",
    "Fetch a spreadsheet's properties and tab list (title, sheetId, rowCount, columnCount).",
    { spreadsheetId: z.string() },
    async ({ spreadsheetId }) =>
      call(async () => {
        const res = await sheets.spreadsheets.get({
          spreadsheetId,
          fields:
            "spreadsheetId,properties(title),sheets(properties(sheetId,title,gridProperties))",
        });
        return res.data;
      }),
  );

  // ── Read / write values ────────────────────────────────────────

  server.tool(
    "read_range",
    "Read cell values from an A1 range, e.g. 'Sheet1!A1:G50'.",
    {
      spreadsheetId: z.string(),
      range: z
        .string()
        .describe("A1 range, e.g. 'Sheet1!A1:G50' or 'A1:G50' for first tab."),
    },
    async ({ spreadsheetId, range }) =>
      call(async () => {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
        });
        return res.data;
      }),
  );

  server.tool(
    "write_range",
    "Write a 2D array of cell values to an A1 range. Overwrites existing values in that range.",
    {
      spreadsheetId: z.string(),
      range: z.string(),
      values: z
        .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
        .describe("Row-major 2D array. Each inner array is one row."),
      valueInputOption: z
        .enum(["RAW", "USER_ENTERED"])
        .optional()
        .describe(
          "USER_ENTERED parses formulas + dates like the UI; RAW stores literal strings. Default USER_ENTERED.",
        ),
    },
    async ({ spreadsheetId, range, values, valueInputOption }) =>
      call(async () => {
        const res = await sheets.spreadsheets.values.update({
          spreadsheetId,
          range,
          valueInputOption: valueInputOption || "USER_ENTERED",
          requestBody: { values: values as any[][] },
        });
        return res.data;
      }),
  );

  server.tool(
    "append_rows",
    "Append rows to the bottom of a sheet tab. Faster than computing the next-empty range yourself.",
    {
      spreadsheetId: z.string(),
      range: z
        .string()
        .describe(
          "Tab range — the API finds the first empty row inside it. Most common: 'Sheet1!A:Z'.",
        ),
      values: z.array(
        z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
      ),
    },
    async ({ spreadsheetId, range, values }) =>
      call(async () => {
        const res = await sheets.spreadsheets.values.append({
          spreadsheetId,
          range,
          valueInputOption: "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: values as any[][] },
        });
        return res.data;
      }),
  );

  // ── Formatting ─────────────────────────────────────────────────

  server.tool(
    "format_header_row",
    "Bold + light-gray-background the first row of a tab and freeze it. Standard 'make this look like a header' move.",
    {
      spreadsheetId: z.string(),
      sheetName: z
        .string()
        .optional()
        .describe("Tab name. Defaults to the first tab if omitted."),
    },
    async ({ spreadsheetId, sheetName }) =>
      call(async () => {
        const sheetId = await resolveSheetId(sheets, spreadsheetId, sheetName);
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                  cell: {
                    userEnteredFormat: {
                      textFormat: { bold: true },
                      backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
                      verticalAlignment: "MIDDLE",
                    },
                  },
                  fields:
                    "userEnteredFormat(textFormat,backgroundColor,verticalAlignment)",
                },
              },
              {
                updateSheetProperties: {
                  properties: {
                    sheetId,
                    gridProperties: { frozenRowCount: 1 },
                  },
                  fields: "gridProperties.frozenRowCount",
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );

  server.tool(
    "autofit_columns",
    "Resize columns so each fits its longest value. Targets a single tab.",
    {
      spreadsheetId: z.string(),
      sheetName: z.string().optional(),
      startColumn: z.number().int().optional(),
      endColumn: z.number().int().optional(),
    },
    async ({ spreadsheetId, sheetName, startColumn, endColumn }) =>
      call(async () => {
        const sheetId = await resolveSheetId(sheets, spreadsheetId, sheetName);
        let end = endColumn;
        if (end === undefined) {
          const meta = await sheets.spreadsheets.get({
            spreadsheetId,
            fields:
              "sheets(properties(sheetId,gridProperties(columnCount)))",
          });
          const tab = meta.data.sheets?.find(
            (s) => s.properties?.sheetId === sheetId,
          );
          end = tab?.properties?.gridProperties?.columnCount ?? 26;
        }
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                autoResizeDimensions: {
                  dimensions: {
                    sheetId,
                    dimension: "COLUMNS",
                    startIndex: startColumn ?? 0,
                    endIndex: end,
                  },
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );

  server.tool(
    "freeze_rows",
    "Freeze the top N rows of a tab so they stay visible during scroll. count=0 to unfreeze.",
    {
      spreadsheetId: z.string(),
      sheetName: z.string().optional(),
      count: z.number().int().min(0),
    },
    async ({ spreadsheetId, sheetName, count }) =>
      call(async () => {
        const sheetId = await resolveSheetId(sheets, spreadsheetId, sheetName);
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                updateSheetProperties: {
                  properties: {
                    sheetId,
                    gridProperties: { frozenRowCount: count },
                  },
                  fields: "gridProperties.frozenRowCount",
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );

  server.tool(
    "wrap_text",
    "Enable text wrapping for an A1 range so long strings don't run off-screen.",
    {
      spreadsheetId: z.string(),
      range: z.string().describe("A1 range, e.g. 'Sheet1!A1:G100'."),
    },
    async ({ spreadsheetId, range }) =>
      call(async () => {
        const r = parseA1(range);
        const sheetId = await resolveSheetId(sheets, spreadsheetId, r.tabName);
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startRowIndex: r.startRowIndex,
                    endRowIndex: r.endRowIndex,
                    startColumnIndex: r.startColumnIndex,
                    endColumnIndex: r.endColumnIndex,
                  },
                  cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
                  fields: "userEnteredFormat.wrapStrategy",
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );

  server.tool(
    "set_background_color",
    "Tint an A1 range with an RGB background color (each channel 0..1). Useful for highlighting status rows.",
    {
      spreadsheetId: z.string(),
      range: z.string().describe("A1 range, e.g. 'Sheet1!A52:G59'."),
      red: z.number().min(0).max(1),
      green: z.number().min(0).max(1),
      blue: z.number().min(0).max(1),
    },
    async ({ spreadsheetId, range, red, green, blue }) =>
      call(async () => {
        const r = parseA1(range);
        const sheetId = await resolveSheetId(sheets, spreadsheetId, r.tabName);
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startRowIndex: r.startRowIndex,
                    endRowIndex: r.endRowIndex,
                    startColumnIndex: r.startColumnIndex,
                    endColumnIndex: r.endColumnIndex,
                  },
                  cell: {
                    userEnteredFormat: {
                      backgroundColor: { red, green, blue },
                    },
                  },
                  fields: "userEnteredFormat.backgroundColor",
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );

  // ── Structure ──────────────────────────────────────────────────

  server.tool(
    "add_sheet_tab",
    "Add a new tab to an existing spreadsheet.",
    { spreadsheetId: z.string(), title: z.string() },
    async ({ spreadsheetId, title }) =>
      call(async () => {
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title } } }],
          },
        });
        return res.data;
      }),
  );

  server.tool(
    "create_spreadsheet",
    "Create a new empty spreadsheet. Returns the new spreadsheetId + URL.",
    {
      title: z.string(),
      sheetTitle: z
        .string()
        .optional()
        .describe("First-tab name. Default 'Sheet1'."),
    },
    async ({ title, sheetTitle }) =>
      call(async () => {
        const res = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title },
            sheets: [{ properties: { title: sheetTitle || "Sheet1" } }],
          },
        });
        return {
          spreadsheetId: res.data.spreadsheetId,
          url: res.data.spreadsheetUrl,
        };
      }),
  );

  // ── Sharing ────────────────────────────────────────────────────

  server.tool(
    "share_with_email",
    "Grant a Drive permission on the spreadsheet to a Google account by email. Roles: reader / commenter / writer.",
    {
      spreadsheetId: z.string(),
      email: z.string().email(),
      role: z.enum(["reader", "commenter", "writer"]),
      sendNotification: z.boolean().optional(),
    },
    async ({ spreadsheetId, email, role, sendNotification }) =>
      call(async () => {
        const res = await drive.permissions.create({
          fileId: spreadsheetId,
          sendNotificationEmail: sendNotification ?? false,
          requestBody: {
            type: "user",
            role,
            emailAddress: email,
          },
        });
        return res.data;
      }),
  );

  // ── One-shot beautify ──────────────────────────────────────────

  server.tool(
    "beautify",
    "Apply the standard look-good combo to a tab: bold + gray header row, freeze row 1, autofit columns, and (optionally) wrap text on a range.",
    {
      spreadsheetId: z.string(),
      sheetName: z.string().optional(),
      wrapRange: z
        .string()
        .optional()
        .describe(
          "Optional A1 range to enable text-wrap on (e.g. 'A2:G100').",
        ),
    },
    async ({ spreadsheetId, sheetName, wrapRange }) =>
      call(async () => {
        const sheetId = await resolveSheetId(sheets, spreadsheetId, sheetName);
        const meta = await sheets.spreadsheets.get({
          spreadsheetId,
          fields:
            "sheets(properties(sheetId,title,gridProperties(columnCount)))",
        });
        const tab = meta.data.sheets?.find(
          (s) => s.properties?.sheetId === sheetId,
        );
        const colCount = tab?.properties?.gridProperties?.columnCount ?? 26;

        const requests: any[] = [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
                  verticalAlignment: "MIDDLE",
                },
              },
              fields:
                "userEnteredFormat(textFormat,backgroundColor,verticalAlignment)",
            },
          },
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { frozenRowCount: 1 },
              },
              fields: "gridProperties.frozenRowCount",
            },
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: colCount,
              },
            },
          },
        ];

        if (wrapRange) {
          const r = parseA1(wrapRange);
          requests.push({
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: r.startRowIndex,
                endRowIndex: r.endRowIndex,
                startColumnIndex: r.startColumnIndex,
                endColumnIndex: r.endColumnIndex,
              },
              cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
              fields: "userEnteredFormat.wrapStrategy",
            },
          });
        }

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests },
        });
        return {
          tabTitle: tab?.properties?.title,
          applied: [
            "bold+gray header",
            "freeze row 1",
            "autofit columns",
          ].concat(wrapRange ? [`wrap_text on ${wrapRange}`] : []),
        };
      }),
  );

  // ── Number format (dates / currency / percent) ─────────────────

  server.tool(
    "set_number_format",
    "Set how a range's values are DISPLAYED (underlying value unchanged): dates, currency, percent, etc. Works on whole columns, e.g. 'Leads!S2:S'.",
    {
      spreadsheetId: z.string(),
      range: z.string().describe("A1 range, e.g. 'Leads!S2:S' or 'Funnel!B14'."),
      type: z
        .enum(["DATE", "TIME", "DATE_TIME", "NUMBER", "CURRENCY", "PERCENT", "TEXT", "SCIENTIFIC"])
        .describe("Sheets NumberFormat type."),
      pattern: z
        .string()
        .optional()
        .describe("Optional custom pattern, e.g. 'yyyy-mm-dd', 'dd-mmm', '₹#,##0', '0.0%'. Omit for the type default."),
    },
    async ({ spreadsheetId, range, type, pattern }) =>
      call(async () => {
        const r = await gridRange(sheets, spreadsheetId, range);
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: r,
                  cell: {
                    userEnteredFormat: {
                      numberFormat: { type, ...(pattern ? { pattern } : {}) },
                    },
                  },
                  fields: "userEnteredFormat.numberFormat",
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );

  // ── Data validation (dropdowns) ────────────────────────────────

  server.tool(
    "set_data_validation",
    "Add a dropdown (data validation) to a range from a fixed value list. Ideal for Status/Priority columns, e.g. range 'Leads!P2:P'.",
    {
      spreadsheetId: z.string(),
      range: z.string().describe("A1 range to apply the dropdown to, e.g. 'Leads!P2:P'."),
      values: z.array(z.string()).min(1).describe("Allowed dropdown values."),
      strict: z
        .boolean()
        .optional()
        .describe("Reject entries not in the list (true) vs warn only (false). Default true."),
      showDropdown: z
        .boolean()
        .optional()
        .describe("Show the dropdown-arrow chip. Default true."),
    },
    async ({ spreadsheetId, range, values, strict, showDropdown }) =>
      call(async () => {
        const r = await gridRange(sheets, spreadsheetId, range);
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                setDataValidation: {
                  range: r,
                  rule: {
                    condition: {
                      type: "ONE_OF_LIST",
                      values: values.map((v) => ({ userEnteredValue: v })),
                    },
                    strict: strict ?? true,
                    showCustomUi: showDropdown ?? true,
                  },
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );

  // ── Text formatting (bold / italic / size / color) ─────────────

  server.tool(
    "set_text_format",
    "Apply text formatting (bold / italic / underline / font size / text color) to any range, including a single header row like 'Today!A8:O8'.",
    {
      spreadsheetId: z.string(),
      range: z.string().describe("A1 range, e.g. 'Today!A8:O8'."),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      fontSize: z.number().int().min(1).optional(),
      red: z.number().min(0).max(1).optional().describe("Text color red channel (0..1)."),
      green: z.number().min(0).max(1).optional(),
      blue: z.number().min(0).max(1).optional(),
    },
    async ({ spreadsheetId, range, bold, italic, underline, fontSize, red, green, blue }) =>
      call(async () => {
        const r = await gridRange(sheets, spreadsheetId, range);
        const tf: Record<string, unknown> = {};
        const f: string[] = [];
        if (bold !== undefined) (tf.bold = bold), f.push("bold");
        if (italic !== undefined) (tf.italic = italic), f.push("italic");
        if (underline !== undefined) (tf.underline = underline), f.push("underline");
        if (fontSize !== undefined) (tf.fontSize = fontSize), f.push("fontSize");
        if (red !== undefined && green !== undefined && blue !== undefined) {
          tf.foregroundColor = { red, green, blue };
          f.push("foregroundColor");
        }
        if (f.length === 0) throw new Error("Provide at least one text-format property.");
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: r,
                  cell: { userEnteredFormat: { textFormat: tf } },
                  fields: `userEnteredFormat.textFormat(${f.join(",")})`,
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );

  // ── Conditional formatting ─────────────────────────────────────

  server.tool(
    "conditional_format",
    "Add a conditional-format rule: when cells in a range match a condition, tint them. E.g. Priority='Hot' -> red.",
    {
      spreadsheetId: z.string(),
      range: z.string().describe("A1 range the rule applies to, e.g. 'Leads!M2:M'."),
      condition: z
        .enum([
          "TEXT_EQ",
          "TEXT_CONTAINS",
          "TEXT_STARTS_WITH",
          "NUMBER_GREATER",
          "NUMBER_LESS",
          "NUMBER_EQ",
          "NOT_BLANK",
          "BLANK",
        ])
        .describe("Boolean condition type."),
      value: z
        .string()
        .optional()
        .describe("Comparison value (required for all except NOT_BLANK / BLANK)."),
      red: z.number().min(0).max(1).describe("Background red channel (0..1)."),
      green: z.number().min(0).max(1),
      blue: z.number().min(0).max(1),
    },
    async ({ spreadsheetId, range, condition, value, red, green, blue }) =>
      call(async () => {
        const r = await gridRange(sheets, spreadsheetId, range);
        const needsValue = condition !== "NOT_BLANK" && condition !== "BLANK";
        if (needsValue && value === undefined) {
          throw new Error(`Condition ${condition} requires a 'value'.`);
        }
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addConditionalFormatRule: {
                  index: 0,
                  rule: {
                    ranges: [r],
                    booleanRule: {
                      condition: {
                        type: condition,
                        ...(needsValue ? { values: [{ userEnteredValue: value }] } : {}),
                      },
                      format: { backgroundColor: { red, green, blue } },
                    },
                  },
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );

  // ── Borders ────────────────────────────────────────────────────

  server.tool(
    "set_borders",
    "Draw borders around and between every cell in a range — makes a block read as a real table.",
    {
      spreadsheetId: z.string(),
      range: z.string().describe("A1 range, e.g. 'Today!A8:E20'."),
      style: z
        .enum(["SOLID", "SOLID_MEDIUM", "SOLID_THICK", "DOTTED", "DASHED"])
        .optional()
        .describe("Border line style. Default SOLID."),
    },
    async ({ spreadsheetId, range, style }) =>
      call(async () => {
        const r = await gridRange(sheets, spreadsheetId, range);
        const b = { style: style ?? "SOLID", color: { red: 0.6, green: 0.6, blue: 0.6 } };
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                updateBorders: {
                  range: r,
                  top: b,
                  bottom: b,
                  left: b,
                  right: b,
                  innerHorizontal: b,
                  innerVertical: b,
                },
              },
            ],
          },
        });
        return res.data;
      }),
  );
}
