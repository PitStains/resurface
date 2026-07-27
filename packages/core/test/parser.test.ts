import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClock, parseEpisodeFile } from "../src/parser.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "vault", "Data");

function load(rel: string): string {
  return readFileSync(join(FIXTURES, rel), "utf8");
}

describe("parseClock", () => {
  it("parses MM:SS and HH:MM:SS", () => {
    expect(parseClock("03:12")).toBe(192);
    expect(parseClock("01:10:50")).toBe(4250);
    expect(parseClock("bogus")).toBeNull();
    expect(parseClock(null)).toBeNull();
  });
});

describe("parseEpisodeFile — interview fixture", () => {
  const ep = parseEpisodeFile(load("The Example Interview Show/Building Better Habits.md"), "x.md");

  it("extracts episode + show identity from share URLs", () => {
    expect(ep.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(ep.showId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(ep.showTitle).toBe("The Example Interview Show");
    expect(ep.publishDate).toBe("2026-03-10");
    expect(ep.lastSnipDate).toBe("2026-03-12");
  });

  it("prefers the body's precise duration over frontmatter minutes", () => {
    expect(ep.durationSec).toBe(1 * 3600 + 5 * 60 + 30);
  });

  it("captures AI description, guests, and books with links", () => {
    expect(ep.aiDescription).toContain("habit formation");
    expect(ep.guests).toHaveLength(1);
    expect(ep.guests[0]).toMatchObject({
      id: "99999999-8888-7777-6666-555555555555",
      name: "Jane Doe",
    });
    expect(ep.books).toHaveLength(1);
    expect(ep.books[0]).toMatchObject({
      id: "12121212-3434-5656-7878-909090909090",
      title: "Atomic Example",
      author: "John Writer",
    });
  });

  it("parses both snips fully", () => {
    expect(ep.snips).toHaveLength(2);
    const [s1, s2] = ep.snips;
    expect(s1.id).toBe("01010101-0202-0303-0404-050505050505");
    expect(s1.title).toBe("Start Small to Win Big");
    expect(s1.startSec).toBe(192);
    expect(s1.endSec).toBe(318);
    expect(s1.durationSec).toBe(125);
    expect(s1.summaryMd).toContain("Tiny habits compound");
    expect(s1.quoteText).toContain("a vote for the person");
    expect(s1.quoteAttribution).toBe("Jane Doe");
    expect(s1.quoteCaption).toBe("Jane on identity-based habits");
    expect(s1.transcriptMd).toContain("two-minute rule");
    expect(s1.transcriptMd).not.toMatch(/---\s*$/);
    // second snip has no quote section
    expect(s2.quoteText).toBeNull();
    expect(s2.transcriptMd).toContain("Willpower is overrated");
  });
});

describe("parseEpisodeFile — devotional fixture", () => {
  const ep = parseEpisodeFile(load("Daily Example Devotional/March 12 _ Morning.md"), "x.md");
  it("handles missing guests/books and plain transcripts", () => {
    expect(ep.guests).toHaveLength(0);
    expect(ep.books).toHaveLength(0);
    expect(ep.snips).toHaveLength(1);
    expect(ep.snips[0].transcriptMd).toContain("plain unlabelled transcript");
    expect(ep.durationSec).toBe(172); // body "02:52" preferred over 3 minutes
  });
  it("reads the Snipd ⭐ favorite and [[tags]] from the heading", () => {
    expect(ep.snips[0].favorited).toBe(true);
    expect(ep.snips[0].tags).toEqual(["grace"]);
    expect(ep.snips[0].title).toBe("Morning Reflection"); // star + tags stripped
    expect(ep.snips[0].id).toBe("31313131-4242-5353-6464-757575757575");
  });
});

describe("parseEpisodeFile — sectioned AI notes (bold sections, prose)", () => {
  const ep = parseEpisodeFile(
    load("The Example Interview Show/Sectioned Notes Episode.md"),
    "The Example Interview Show/Sectioned Notes Episode.md"
  );
  it("keeps prose sections in the summary (bullets-only extraction lost these)", () => {
    expect(ep.snips).toHaveLength(1);
    const s = ep.snips[0].summaryMd!;
    expect(s).toContain("**2. Main Theme**");
    expect(s).toContain("eternal counsel precedes every act");
    expect(s).toContain("**4. Practical Application**");
    expect(s).toContain("- Begin with thanksgiving each morning.");
    expect(s).not.toContain("🎧");
    expect(s).not.toContain("<iframe");
    expect(ep.snips[0].favorited).toBe(false);
  });
});

describe("parseEpisodeFile — private upload fixture", () => {
  const ep = parseEpisodeFile(load("Your uploads/My Audiobook.md"), "Your uploads/My Audiobook.md");
  it("derives stable ids when share URLs are absent, with warnings", () => {
    expect(ep.id).toMatch(/^[0-9a-f]{40}$/);
    expect(ep.snips).toHaveLength(1);
    expect(ep.snips[0].id).toMatch(/^[0-9a-f]{40}$/);
    expect(ep.warnings.some((w) => w.includes("no episode share URL"))).toBe(true);
    expect(ep.warnings.some((w) => w.includes("no share URL, using derived id"))).toBe(true);
  });
  it("derived ids are deterministic", () => {
    const again = parseEpisodeFile(load("Your uploads/My Audiobook.md"), "Your uploads/My Audiobook.md");
    expect(again.id).toBe(ep.id);
    expect(again.snips[0].id).toBe(ep.snips[0].id);
  });
});

describe("parseEpisodeFile — malformed frontmatter", () => {
  it("is rescued by the lenient parser with a warning", () => {
    const ep = parseEpisodeFile(load("Broken Show/Malformed Episode.md"), "Broken Show/Malformed Episode.md");
    expect(ep.warnings.some((w) => w.includes("used lenient parser"))).toBe(true);
    expect(ep.showTitle).toBe("Broken Show");
    expect(ep.warnings.some((w) => w.includes("no snips found"))).toBe(true);
  });
});

describe("parseEpisodeFile — at-sign author (invalid YAML seen in real exports)", () => {
  it("recovers all fields via the lenient parser", () => {
    const ep = parseEpisodeFile(load("Edge Case Show/At-Sign Author.md"), "Edge Case Show/At-Sign Author.md");
    expect(ep.warnings.some((w) => w.includes("used lenient parser"))).toBe(true);
    expect(ep.id).toBe("41414141-5252-6363-7474-858585858585");
    expect(ep.title).toBe("At-Sign Author: A Test");
    expect(ep.showAuthor).toBe("@SomeHandle & @OtherHandle");
    expect(ep.durationSec).toBe(36 * 60);
    expect(ep.snips).toHaveLength(1);
    expect(ep.snips[0].id).toBe("51515151-6262-7373-8484-959595959595");
  });
});

describe("parseEpisodeFile — hash-prefixed show title (YAML comment swallows it)", () => {
  it("recovers the title from the body metadata bullet", () => {
    const ep = parseEpisodeFile(load("_HashTitle/Hash Title Episode.md"), "_HashTitle/Hash Title Episode.md");
    expect(ep.showTitle).toBe("#HashTitle");
    expect(ep.warnings.some((w) => w.includes("show_title missing"))).toBe(true);
    expect(ep.snips).toHaveLength(1);
  });
});

describe("parseEpisodeFile — mojibake + outline headings inside snip body", () => {
  const ep = parseEpisodeFile(
    load("Sermon Show/Mojibake Outline Sermon.md"),
    "Sermon Show/Mojibake Outline Sermon.md"
  );
  it("repairs double-encoded UTF-8 and parses the time range", () => {
    expect(ep.warnings.some((w) => w.includes("repaired double-encoded"))).toBe(true);
    expect(ep.snips).toHaveLength(1);
    expect(ep.snips[0].startSec).toBe(3 * 60 + 22);
    expect(ep.snips[0].transcriptMd).toContain("preacher’s transcript");
  });
  it("keeps ### outline headings inside the snip body, not as new snips", () => {
    expect(ep.snips[0].summaryMd).toContain("Outline headings must not be mistaken");
  });
});
