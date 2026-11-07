import * as Schema from "effect/Schema";

const decodeIds = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);

export async function hasTestFlightTesters(
  apple: (path: string) => Promise<unknown>,
  buildId: string,
) {
  // Apple's build betaGroups relationship supports writes only; read through the collection.
  const query = new URLSearchParams({ "filter[builds]": buildId, limit: "200" });
  const groups = decodeIds(await apple(`betaGroups?${query}`));
  for (const group of groups.data) {
    const testers = decodeIds(await apple(`betaGroups/${group.id}/betaTesters?limit=1`));
    if (testers.data.length) return true;
  }
  return false;
}
