export interface ExtractedEntity {
  name: string;
  type: "code" | "file" | "concept" | "proper_noun" | "technical";
}

export interface ExtractedClaim {
  text: string;
}

const CODE_PATTERN = /`([^`]{2,60})`/g;
const FILE_PATTERN =
  /(?:^|\s)((?:[\w./-]+\/)?[\w.-]+\.(?:ts|js|tsx|jsx|py|rs|go|java|rb|sh|sql|md|json|yaml|yml|toml|css|html|vue|svelte))\b/g;
const CAMEL_CASE = /\b([a-z][a-zA-Z0-9]{2,}[A-Z][a-zA-Z0-9]*)\b/g;
const PASCAL_CASE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+){1,})\b/g;
const SNAKE_CASE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\b/g;
const SCREAMING_SNAKE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,})\b/g;

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "will",
  "with", "this", "that", "from", "they", "were", "which", "their",
  "what", "there", "when", "make", "like", "each", "just", "over",
  "such", "than", "into", "some", "could", "them", "other", "then",
  "these", "would", "about", "should", "because", "using", "also",
]);

export function extractEntities(content: string): ExtractedEntity[] {
  const seen = new Set<string>();
  const entities: ExtractedEntity[] = [];

  function add(name: string, type: ExtractedEntity["type"]) {
    const key = `${type}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ name, type });
  }

  // Inline code spans
  for (const m of content.matchAll(CODE_PATTERN)) {
    const val = m[1].trim();
    if (val.includes(" ") && val.length > 40) continue;
    add(val, "code");
  }

  // Strip code blocks before other extraction
  const noCodeBlocks = content.replace(/```[\s\S]*?```/g, "");

  // File paths
  for (const m of noCodeBlocks.matchAll(FILE_PATTERN)) {
    add(m[1], "file");
  }

  // camelCase, PascalCase, snake_case, SCREAMING_SNAKE
  for (const m of noCodeBlocks.matchAll(CAMEL_CASE)) add(m[1], "technical");
  for (const m of noCodeBlocks.matchAll(PASCAL_CASE)) add(m[1], "technical");
  for (const m of noCodeBlocks.matchAll(SNAKE_CASE)) {
    if (!STOP_WORDS.has(m[1])) add(m[1], "technical");
  }
  for (const m of noCodeBlocks.matchAll(SCREAMING_SNAKE)) add(m[1], "technical");

  // Multi-word proper nouns (2-4 consecutive capitalized words, not at sentence start)
  const properNounPattern =
    /(?<=[.!?]\s+\w+\s+|,\s+|;\s+|\n\w+\s+)((?:[A-Z][a-z]+\s+){1,3}[A-Z][a-z]+)/g;
  for (const m of noCodeBlocks.matchAll(properNounPattern)) {
    const phrase = m[1].trim();
    if (phrase.length > 3 && phrase.length < 60) {
      add(phrase, "proper_noun");
    }
  }

  // Concept extraction: quoted terms
  const quotedPattern = /"([^"]{3,50})"/g;
  for (const m of noCodeBlocks.matchAll(quotedPattern)) {
    add(m[1], "concept");
  }

  return entities;
}

export function extractClaims(content: string): ExtractedClaim[] {
  const noCodeBlocks = content.replace(/```[\s\S]*?```/g, "");
  const noFrontmatter = noCodeBlocks.replace(/^---[\s\S]*?---\n?/, "");

  const sentences = noFrontmatter
    .split(/(?<=[.!])\s+/)
    .map((s) => s.replace(/\n/g, " ").trim())
    .filter((s) => s.length > 20 && s.length < 300);

  const claims: ExtractedClaim[] = [];
  const declarative =
    /\b(is|are|was|were|uses?|requires?|depends?|should|must|always|never|because|means?|provides?|returns?|stores?|creates?|implements?)\b/i;

  for (const sentence of sentences) {
    if (sentence.endsWith("?")) continue;
    if (sentence.startsWith("-") || sentence.startsWith("*")) {
      const stripped = sentence.replace(/^[-*]\s*/, "");
      if (stripped.length > 15 && declarative.test(stripped)) {
        claims.push({ text: stripped });
      }
      continue;
    }
    if (declarative.test(sentence)) {
      claims.push({ text: sentence });
    }
  }

  return claims.slice(0, 20);
}
