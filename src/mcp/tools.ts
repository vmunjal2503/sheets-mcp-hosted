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
}
