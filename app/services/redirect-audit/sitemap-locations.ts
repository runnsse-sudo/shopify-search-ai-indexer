import { Parser } from "htmlparser2";

/** Read the direct loc elements without building a tree for image and other metadata. */
export function parseRedirectSitemapLocations(xml: string): {
  kind: "INDEX" | "URLSET";
  locations: string[];
} {
  if (!xml.trim()) {
    throw new Error("SITEMAP_XML_EMPTY");
  }

  let root = "";
  let depth = 0;
  let entryTag = "";
  let inEntry = false;
  let sawLocation = false;
  let inLocation = false;
  let location = "";
  const locations: string[] = [];

  const parser = new Parser({
    onopentagname(name) {
      depth += 1;
      if (depth === 1) {
        if (root || (name !== "sitemapindex" && name !== "urlset")) {
          throw new Error("SITEMAP_XML_ROOT_UNSUPPORTED");
        }
        root = name;
        entryTag = name === "sitemapindex" ? "sitemap" : "url";
      } else if (depth === 2 && name === entryTag) {
        inEntry = true;
        sawLocation = false;
      } else if (depth === 3 && inEntry && name === "loc" && !sawLocation) {
        sawLocation = true;
        inLocation = true;
        location = "";
      }
    },
    ontext(text) {
      if (inLocation) location += text;
    },
    onclosetag() {
      if (depth === 3 && inLocation) {
        const value = location.trim();
        if (value) locations.push(value);
        location = "";
        inLocation = false;
      } else if (depth === 2) {
        inEntry = false;
      }
      depth -= 1;
    },
  }, { xmlMode: true });

  parser.end(xml);
  if (!root) throw new Error("SITEMAP_XML_ROOT_UNSUPPORTED");

  return { kind: root === "sitemapindex" ? "INDEX" : "URLSET", locations };
}
