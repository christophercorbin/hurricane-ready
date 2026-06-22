/**
 * Alert dispatch. Fires only when the threat level CHANGES (de-duped by
 * the caller via state). All channels optional; failures are logged,
 * never fatal.
 *
 * The second arg is for dependency injection — tests pass fake clients and
 * a fake fetch; production gets real SES/SNS clients and the global fetch.
 * (Issue #26: this is what makes the path testable without real AWS.)
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const LEVEL_LABEL = {
  ALL_CLEAR: "All clear",
  WATCH: "Watch",
  WARNING: "Warning",
  IMMINENT: "Imminent",
};

export async function dispatchAlert(
  { level, previousLevel, briefing, island, alerts, region },
  { sesClient, snsClient, httpFetch = fetch } = {},
) {
  const subject = `[Hurricane-Ready] ${island.name}: ${LEVEL_LABEL[level]} (was ${LEVEL_LABEL[previousLevel]})`;
  const results = [];

  if (alerts.emails.length > 0 && alerts.senderEmail) {
    const ses = sesClient ?? new SESv2Client({ region });
    try {
      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: alerts.senderEmail,
          Destination: { ToAddresses: alerts.emails },
          Content: {
            Simple: {
              Subject: { Data: subject },
              Body: { Text: { Data: briefing } },
            },
          },
        })
      );
      results.push({ channel: "email", ok: true, count: alerts.emails.length });
    } catch (err) {
      console.error("Email dispatch failed", err.name);
      results.push({ channel: "email", ok: false });
    }
  }

  if (alerts.phones.length > 0) {
    const sns = snsClient ?? new SNSClient({ region });
    // SMS must be short: level + first line of guidance
    const sms = `${subject}. ${briefing.split("\n")[0]} Follow Barbados Met Services & DEM.`.slice(0, 300);
    for (const phone of alerts.phones) {
      try {
        await sns.send(new PublishCommand({ PhoneNumber: phone, Message: sms }));
        results.push({ channel: "sms", ok: true, to: phone.slice(0, 6) + "..." });
      } catch (err) {
        console.error(`SMS to ${phone.slice(0, 6)}... failed`, err.name);
        results.push({ channel: "sms", ok: false });
      }
    }
  }

  if (alerts.webhookUrl) {
    try {
      const res = await httpFetch(alerts.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Slack/Discord-compatible plus structured fields
          text: `*${subject}*\n\n${briefing}`,
          content: `**${subject}**\n\n${briefing}`,
          level,
          previousLevel,
          island: island.name,
        }),
        // 8s timeout (#38): a slow webhook can otherwise hold up the entire
        // dispatch tick, delaying push fan-out to real subscribers.
        signal: AbortSignal.timeout(8000),
      });
      results.push({ channel: "webhook", ok: res.ok });
    } catch (err) {
      console.error("Webhook dispatch failed", err.name);
      results.push({ channel: "webhook", ok: false });
    }
  }

  return results;
}
