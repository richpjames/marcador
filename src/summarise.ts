import { Mistral } from "@mistralai/mistralai";
import { config } from "./config.ts";
import type { PageMetadata } from "./metadata.ts";

/**
 * Turns a scraped page into the one-sentence description shown under each link.
 *
 * Summarisation is best-effort by design: a link that saves but arrives without
 * a sentence is still a useful bookmark, whereas a link that fails to save
 * because the LLM was rate-limited is lost. Every failure path here returns
 * `null` and lets the caller fall back to the page's own description.
 */

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------
//
// Kept to a plain description on purpose: the sentence says what the page is,
// and leaves judging it to the reader.
//
// The three constraints are here because dropping them measurably hurt. Without
// the "no preamble" line every sentence opened with "This web page is about",
// spending a quarter of its words saying nothing. Without the word cap it
// drifted past 30 words on documentation pages. Without "do not repeat the
// title" it restated the heading printed directly above it.
//
const SYSTEM_PROMPT = `Write one sentence, at most 25 words, describing what this web page is about.

Do not repeat the title and do not start with "This web page" or "This article".
Reply with the sentence only.`;

/** Guard against a chatty model blowing out the list layout. */
const MAX_DESCRIPTION_CHARS = 300;

export interface Summariser {
  summarise(url: string, page: PageMetadata): Promise<string | null>;
}

/** Used when MISTRAL_API_KEY is unset, so the app runs fine without a key. */
export const nullSummariser: Summariser = {
  async summarise() {
    return null;
  },
};

export function createSummariser(
  apiKey = config.mistralApiKey,
  model = config.mistralModel,
): Summariser {
  if (!apiKey) return nullSummariser;

  const client = new Mistral({ apiKey });

  return {
    async summarise(url, page) {
      const context = [
        `URL: ${url}`,
        page.title ? `Title: ${page.title}` : null,
        page.siteName ? `Site: ${page.siteName}` : null,
        page.pageDescription ? `Page description: ${page.pageDescription}` : null,
        page.excerpt ? `Page text:\n${page.excerpt}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        const response = await client.chat.complete({
          model,
          temperature: 0.2,
          maxTokens: 120,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: context },
          ],
        });

        return clean(contentToText(response.choices?.[0]?.message?.content));
      } catch (error) {
        console.error("[summarise] Mistral call failed:", error);
        return null;
      }
    },
  };
}

/** The SDK returns either a string or an array of content chunks. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((chunk) =>
      typeof chunk === "string"
        ? chunk
        : chunk && typeof chunk === "object" && "text" in chunk
          ? String((chunk as { text: unknown }).text ?? "")
          : "",
    )
    .join("");
}

function clean(text: string): string | null {
  const sentence = text
    .trim()
    .replace(/^["'“‘]|["'”’]$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return sentence ? sentence.slice(0, MAX_DESCRIPTION_CHARS) : null;
}
