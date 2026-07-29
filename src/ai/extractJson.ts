/** AIが ```json ... ``` のコードフェンスで包んで返すことがあるため、剥がしてから JSON.parse する */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}
