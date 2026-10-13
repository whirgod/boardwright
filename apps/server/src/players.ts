/**
 * Who occupies a Seat. Discriminated by `kind` so new kinds of Player
 * (e.g. `{ kind: "engine", engineId, limits }`, #7) extend the union without
 * reshaping the API: requests, stored records and responses all carry this
 * object as-is.
 */
export type PlayerSpec = HumanPlayerSpec;

/** A human Player; moves by presenting the Seat's seat token. */
export interface HumanPlayerSpec {
  readonly kind: "human";
}

export type PlayerKind = PlayerSpec["kind"];

/** Whether Moves for this Player arrive over the API with a seat token. */
export function isTokenHolder(player: PlayerSpec): boolean {
  return player.kind === "human";
}

/**
 * Validate an untrusted JSON value as a PlayerSpec. Returns the parsed spec, or
 * a human-readable problem description.
 */
export function parsePlayerSpec(
  value: unknown,
): { ok: true; player: PlayerSpec } | { ok: false; problem: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, problem: "must be an object with a `kind`" };
  }
  const { kind, ...rest } = value as Record<string, unknown>;
  switch (kind) {
    case "human":
      if (Object.keys(rest).length > 0) {
        return {
          ok: false,
          problem: `unexpected field(s) for kind "human": ${
            Object.keys(rest).join(", ")
          }`,
        };
      }
      return { ok: true, player: { kind: "human" } };
    default:
      return {
        ok: false,
        problem: `unknown Player kind ${
          JSON.stringify(kind)
        } (expected "human")`,
      };
  }
}
