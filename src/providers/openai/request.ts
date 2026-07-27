import { REASONING_VARIANTS } from "./models.js";

interface SSEData {
  readonly event: string;
  readonly data: string;
}

function parseSSE(body: string): SSEData[] {
  const events: SSEData[] = [];
  let currentEvent = "";
  let currentData = "";

  for (const line of body.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "") {
      if (currentData) {
        events.push({ event: currentEvent, data: currentData });
      }
      currentEvent = "";
      currentData = "";
    }
  }

  if (currentData) {
    events.push({ event: currentEvent, data: currentData });
  }

  return events;
}

function buildChatCompletionFromSSE(
  events: SSEData[],
  model: string,
): Record<string, unknown> {
  let fullText = "";
  let responseId = `chatcmpl-${crypto.randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let usage: Record<string, number> = {};

  for (const evt of events) {
    try {
      const parsed = JSON.parse(evt.data);

      if (evt.event === "response.output_text.delta") {
        fullText += parsed.delta || "";
      }

      if (evt.event === "response.completed" && parsed.response) {
        created = parsed.response.created_at;
        if (parsed.response.id) responseId = parsed.response.id;
        if (parsed.response.usage) {
          usage = {
            prompt_tokens: parsed.response.usage.input_tokens || 0,
            completion_tokens: parsed.response.usage.output_tokens || 0,
            total_tokens: parsed.response.usage.total_tokens || 0,
          };
        }
      }
    } catch { /* skip malformed events */ }
  }

  return {
    id: responseId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullText,
        },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

export function toResponsesBody(chatBody: Record<string, unknown>): Record<string, unknown> {
  const messages = (chatBody.messages as Array<Record<string, unknown>>) || [];

  let instructions = "You are a helpful assistant.";
  const filteredMessages = messages.filter((message) => {
    if (message.role === "system") {
      instructions = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return false;
    }
    return true;
  });

  const input = filteredMessages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
  }));

  const body: Record<string, unknown> = {
    model: chatBody.model,
    input,
    instructions,
    store: false,
    stream: true,
  };

  const effort =
    typeof chatBody.reasoningEffort === "string" ? chatBody.reasoningEffort
      : typeof chatBody.reasoning_effort === "string" ? chatBody.reasoning_effort
        : undefined;
  if (effort && REASONING_VARIANTS.includes(effort as typeof REASONING_VARIANTS[number])) {
    body.reasoning = { effort };
  }

  return body;
}

export async function wrapSSEAsChatCompletion(
  sseResponse: Response,
  model: string | undefined,
): Promise<Response> {
  const sseText = await sseResponse.text();
  const events = parseSSE(sseText);
  const completion = buildChatCompletionFromSSE(events, model || "");
  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
