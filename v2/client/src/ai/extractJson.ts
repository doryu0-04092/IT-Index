/** AIが ```json ... ``` のコードフェンスで包んで返すことがあるため、剥がしてからJSON.parseする(v1と同じ) */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}
