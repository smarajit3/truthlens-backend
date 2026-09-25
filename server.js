import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const HOST = "0.0.0.0";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

app.use(cors());
app.use(express.json({ limit: "12mb" }));

function getAI() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function cleanJsonText(text) {
  if (!text) return "";
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function generateJson(contents, fallback) {
  const ai = getAI();

  const models = [
    MODEL,
    "gemini-3.7-flash",
    "gemini-3.5-flash-lite"
  ];

  let lastError;

  // 1. Try Gemini first
  for (const model of [...new Set(models)]) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          responseMimeType: "application/json"
        }
      });

      const raw = cleanJsonText(response.text || "");

      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }

    } catch (error) {
      lastError = error;

      const message = String(error?.message || error || "");

      const quotaOrTemporary =
        message.includes("429") ||
        message.includes("RESOURCE_EXHAUSTED") ||
        message.includes("503") ||
        message.includes("UNAVAILABLE") ||
        message.includes("high demand") ||
        message.includes("temporarily");

      console.error(
        `Gemini failed: model=${model}`,
        message
      );

      // For normal errors, don't hide the problem.
      if (!quotaOrTemporary) {
        throw error;
      }
    }
  }

  // 2. Gemini unavailable/quota exhausted → OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    try {
      console.log("Gemini unavailable. Trying OpenRouter free fallback...");

      const messages = contents.map(item => {
        const parts = item.parts || [];

        const content = parts.map(part => {
          if (part.text) {
            return {
              type: "text",
              text: part.text
            };
          }

          if (part.inlineData) {
            return {
              type: "image_url",
              image_url: {
                url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
              }
            };
          }

          return null;
        }).filter(Boolean);

        return {
          role: item.role === "model" ? "assistant" : "user",
          content
        };
      });

      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://smarajit3.github.io/truthlens/",
            "X-Title": "TruthLens"
          },
          body: JSON.stringify({
            model: "openrouter/free",
            messages,
            response_format: {
              type: "json_object"
            }
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data?.error?.message ||
          `OpenRouter request failed (${response.status})`
        );
      }

      const text =
        data?.choices?.[0]?.message?.content || "";

      const raw = cleanJsonText(text);

      try {
        return JSON.parse(raw);
      } catch {
        console.error("OpenRouter returned invalid JSON.");
        return fallback;
      }

    } catch (error) {
      console.error(
        "OpenRouter fallback failed:",
        error?.message || error
      );

      lastError = error;
    }
  }

  throw lastError ||
    new Error("All AI providers are temporarily unavailable.");
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "truthlens-backend",
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    model: MODEL
  });
});

app.post("/api/analyze-image", async (req, res) => {
  try {
    const { imageData, mimeType = "image/jpeg" } = req.body || {};

    if (!imageData) {
      return res.status(400).json({ error: "imageData is required." });
    }

    const base64 = String(imageData).replace(/^data:[^;]+;base64,/, "");

    const prompt = `You are the extraction component of TruthLens, an evidence-first misinformation checking tool.

Analyze the supplied screenshot/image. Extract only information that is actually visible or clearly readable.

Return JSON with this exact structure:
{
  "text": "all readable text, preserving useful line breaks",
  "claims": [
    {
      "claim": "a single checkable factual claim",
      "importance": "high|medium|low"
    }
  ],
  "context": "brief description of what the image appears to be"
}

Do not invent missing text. Do not decide whether claims are true or false at this stage.`;

    const result = await generateJson(
      [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: base64
              }
            }
          ]
        }
      ],
      { text: "", claims: [], context: "" }
    );

    res.json(result);
  } catch (error) {
    console.error("analyze-image error:", error);
    res.status(500).json({ error: error.message || "Image analysis failed." });
  }
});

app.post("/api/evidence-search", async (req, res) => {
  try {
    const { claim } = req.body || {};

    const cleanClaim = String(claim || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleanClaim) {
      return res.status(400).json({
        error: "claim is required."
      });
    }

    const query = encodeURIComponent(cleanClaim);

    const rssUrl =
      `https://news.google.com/rss/search` +
      `?q=${query}` +
      `&hl=en-IN` +
      `&gl=IN` +
      `&ceid=IN:en`;

    const response = await fetch(rssUrl, {
      headers: {
        "User-Agent": "TruthLens/1.0 evidence-discovery"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Google News RSS returned HTTP ${response.status}`
      );
    }

    const xml = await response.text();

    const cleanText = (value = "") => {
      return String(value)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    };

    const cleanSnippet = (value = "") => {
      return String(value)
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    };

    const getTag = (item, tag) => {
      const match = item.match(
        new RegExp(
          `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
          "i"
        )
      );

      return match ? cleanText(match[1]) : "";
    };

    const itemMatches =
      xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

    const items = [];
    const seenLinks = new Set();

    for (const item of itemMatches) {
      if (items.length >= 10) break;

      const title = getTag(item, "title");
      const link = getTag(item, "link");
      const pubDate = getTag(item, "pubDate");
      const description = cleanSnippet(
        getTag(item, "description")
      );
       

      const sourceMatch = item.match(
        /<source[^>]*>([\s\S]*?)<\/source>/i
      );

      const source = sourceMatch
        ? cleanText(sourceMatch[1])
        : "";

      if (!title || !link) continue;

      if (seenLinks.has(link)) continue;
      seenLinks.add(link);

      items.push({
        index: items.length,
        title,
        source,
        link,
        pubDate,
        snippet: description
      });
    }

    res.json({
      query: cleanClaim,

      evidence: items,

      evidenceQuality: {
        type: "discovery",
        verifiedArticleContent: false,
        headlineOnly: items.every(
          item => !item.snippet
        )
      },

      note:
        "These results are evidence-discovery sources. " +
        "Headlines and snippets are not proof by themselves. " +
        "TruthLens should assess the underlying articles before " +
        "classifying a claim as supported or contradicted.",

      searchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error(
      "evidence-search error:",
      error
    );

    res.status(500).json({
      error:
        error.message ||
        "Evidence search failed."
    });
  }
});

app.post("/api/verify", async (req, res) => {
  try {
    const { claims = [], evidence = [] } = req.body || {};

    if (!Array.isArray(claims) || claims.length === 0) {
      return res.status(400).json({ error: "claims must be a non-empty array." });
    }

    const prompt = `You are the verification component of TruthLens.

Your job is to compare factual claims against the supplied evidence. Do not use unsupported outside knowledge. Do not treat absence of evidence as proof that a claim is false.

For each claim, return one status:
- "supported": evidence materially supports the claim
- "contradicted": credible evidence materially conflicts with the claim
- "unclear": evidence is insufficient, conflicting, outdated, or not directly relevant

Return JSON:
{
  "overall": "supported|contradicted|mixed|unclear",
  "summary": "short neutral explanation",
  "claims": [
    {
      "claim": "...",
      "status": "supported|contradicted|unclear",
      "reason": "...",
      "evidenceIndexes": [0]
    }
  ],
  "cautions": ["..."]
}

Claims:
${JSON.stringify(claims, null, 2)}

Evidence:
${JSON.stringify(evidence, null, 2)}
`;

    const result = await generateJson(
      [{ role: "user", parts: [{ text: prompt }] }],
      {
        overall: "unclear",
        summary: "The available evidence was insufficient for a confident determination.",
        claims: claims.map((claim) => ({
          claim: typeof claim === "string" ? claim : claim.claim || "",
          status: "unclear",
          reason: "No reliable determination could be made.",
          evidenceIndexes: []
        })),
        cautions: ["AI-assisted verification should be checked against the underlying sources."]
      }
    );

    res.json(result);
  } catch (error) {
    console.error("verify error:", error);
    res.status(500).json({ error: error.message || "Verification failed." });
  }
});

app.get("/", (_req, res) => {
  res.json({
    name: "TruthLens API",
    status: "online",
    health: "/api/health"
  });
});

app.listen(PORT, HOST, () => {
  console.log(`TruthLens backend listening on http://${HOST}:${PORT}`);
});
