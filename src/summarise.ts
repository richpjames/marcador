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
// TODO(rich): this is the sentence you will read a hundred times a week, so the
// wording here is worth your judgement rather than mine. The default below is a
// starting point — rewrite it to taste.
//
// Trade-offs to weigh:
//   * Descriptive ("A guide to X that covers Y") vs. evaluative ("Argues that
//     X is overrated"). Descriptive is safer; evaluative is far more useful
//     when scanning a long list months later.
//   * Whether to allow the model to say it cannot tell. A confident sentence
//     about a paywalled page is worse than an honest "Paywalled article about X".
//   * Length. One sentence is the ask, but "under 20 words" reads very
//     differently from "under 40".
//   * Whether it may repeat the title. Often the title already says it, and a
//     restated title is wasted screen space.
//
const SYSTEM_PROMPT = `You write one-sentence descriptions for saved bookmarks.

Given a web page, reply with a single sentence of at most 25 words describing what
the page actually contains, so the reader can decide months later whether to open it.

Rules:
- Do not repeat the title. Add what the title leaves out.
- Be concrete. Name the specific subject, tool, or argument.
- No marketing language, no "this article", no preamble, no quotation marks.
- If the page content is missing, paywalled, or unreadable, say so plainly in the sentence.
- Reply with the sentence only.`;

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
