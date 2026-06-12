/**
 * AI briefing layer. Claude on Bedrock explains the threat decision in
 * calm, plain language. It NEVER decides the level - threat.mjs does.
 * Falls back to solid templates when Bedrock is unavailable.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const SYSTEM = `You write public hurricane-preparedness briefings for residents of a Caribbean island. You receive a threat assessment computed by deterministic software, plus raw storm data.

Hard rules:
- NEVER change, second-guess, or restate a different threat level than the one provided. The level is decided by software, not by you.
- Calm, clear, practical. No drama, no minimizing. Short sentences. Plain words.
- Structure: 1) what is happening in one or two sentences; 2) what this level means for the island; 3) a checklist of 4-6 actions appropriate to THIS level only; 4) one line on when the next update is expected.
- End with: "Always follow official guidance from Barbados Meteorological Services and the Department of Emergency Management."
- Keep it under 220 words. Plain text with simple dashes for the checklist.`;

const TEMPLATES = {
  ALL_CLEAR: (island) =>
    `No active tropical systems currently threaten ${island}. No action is needed beyond normal seasonal readiness: know your shelter locations, keep documents in a waterproof container, and maintain a basic supply kit.\n\nAlways follow official guidance from Barbados Meteorological Services and the Department of Emergency Management.`,
  WATCH: (island, s) =>
    `A tropical system (${s?.name ?? "unnamed"}) is active in the Atlantic basin. It poses no immediate threat to ${island}, but conditions can change.\n\n- Review your family emergency plan\n- Check your supply kit: water, food, medication, batteries\n- Note your nearest shelter and route\n- Keep phones charged and follow daily updates\n\nAlways follow official guidance from Barbados Meteorological Services and the Department of Emergency Management.`,
  WARNING: (island, s) =>
    `${s?.name ?? "A storm"} is forecast to pass near ${island}. Preparations should be completed soon.\n\n- Complete shopping now: water (1 gallon per person per day), non-perishables, medication\n- Secure loose outdoor items and shutters\n- Fill vehicle tanks and charge power banks\n- Prepare important documents to carry\n- Confirm arrangements for elderly or vulnerable family members\n\nAlways follow official guidance from Barbados Meteorological Services and the Department of Emergency Management.`,
  IMMINENT: (island, s) =>
    `${s?.name ?? "A storm"} is expected to affect ${island} within roughly 48 hours or is already nearby. Finish preparations and be ready to shelter.\n\n- Stay indoors away from windows once conditions deteriorate\n- Move to your safe room or shelter if instructed\n- Do not go outside during the eye calm\n- Keep radio or phone on official channels\n- Check on neighbours only while it is safe\n\nAlways follow official guidance from Barbados Meteorological Services and the Department of Emergency Management.`,
};

export function templateBriefing(level, islandName, primaryStorm) {
  return TEMPLATES[level](islandName, primaryStorm);
}

export async function generateBriefing(assessment, island, bedrockConfig) {
  const primary = assessment.storms.find(
    (s) => s.assessment.level === assessment.overall
  );

  if (!bedrockConfig.enabled) {
    return {
      text: templateBriefing(assessment.overall, island.name, primary),
      source: "template",
    };
  }

  try {
    const client = new BedrockRuntimeClient({ region: bedrockConfig.region });
    const excerpt = primary?.advisoryExcerpt
      ? `\n\nOfficial NHC forecast advisory excerpt (for accurate detail; the computed level above still stands):\n${primary.advisoryExcerpt}`
      : "";
    const stormData = assessment.storms.map(
      ({ advisoryExcerpt, ...s }) => s
    );
    const result = await client.send(
      new ConverseCommand({
        modelId: bedrockConfig.modelId,
        system: [{ text: SYSTEM }],
        messages: [
          {
            role: "user",
            content: [
              {
                text: `Island: ${island.name}\nComputed threat level (do not alter): ${assessment.overall}\n\nStorm data:\n${JSON.stringify(stormData, null, 2)}${excerpt}\n\nWrite the briefing.`,
              },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 500, temperature: 0.3 },
      })
    );
    const text =
      result.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
    if (!text) throw new Error("empty briefing");
    return { text, source: "claude" };
  } catch (err) {
    console.warn(`Bedrock briefing failed (${err.name}); using template`);
    return {
      text: templateBriefing(assessment.overall, island.name, primary),
      source: "template",
    };
  }
}
