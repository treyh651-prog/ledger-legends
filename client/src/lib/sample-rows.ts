/**
 * Split a pasted sample of CSV rows into a header and its data rows. This is
 * how the mapping profile preview reads what a person pasted, and it is the
 * same shape rule the import runs use: the header is a row of names and every
 * row after it is data. Nothing here is uploaded or sent anywhere.
 */
export function parseSampleRows(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const split = (line: string): string[] => line.split(/[,\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
  return { header: split(lines[0] ?? ""), rows: lines.slice(1).map(split) };
}
