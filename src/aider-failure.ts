// Aider 0.86.2: exceptions.py EXCEPTIONS/get_ex_info and
// coders/base_coder.py send_message catch provider exceptions and return
// normally. These diagnostics therefore override a zero process exit.
const PROVIDER_MESSAGES = [
  "The API provider is not able to authenticate you. Check your API key.",
  "The API provider's servers are down or overloaded.",
  "The API provider has refused the request due to a safety policy about the content.",
  "The API provider was unable to fetch one or more images.",
  "The API provider has rate limited you. Try again later or check your quotas.",
  "The API provider timed out without returning a response. They may be down or overloaded.",
  "OpenRouter or the upstream API provider is down, overloaded or rate limiting your requests.",
  "Insufficient credits with the API provider. Please add credits.",
  "You need to: pip install boto3",
];

export function aiderProviderFailure(output: string): string | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
  return PROVIDER_MESSAGES.find((message) => text.includes(message)) ??
    (/\blitellm\.(?:[A-Za-z]+Error|Timeout)\b/.test(text) ? "aider reported a LiteLLM provider failure" : null);
}

/** io.py writes tool errors/warnings as blockquotes and assistant text
 * without that prefix. Only an answer following an explicit retry can
 * clear a provider error; partial text after a terminal error cannot. */
export function aiderHistoryProviderFailure(history: string): string | null {
  let diagnostics: string[] = [];
  let retrying = false;
  for (const line of history.split("\n")) {
    if (line.startsWith("> ")) {
      const text = line.slice(2);
      diagnostics.push(text);
      if (/^Retrying in \d+(?:\.\d+)? seconds\.\.\./.test(text)) retrying = true;
      else if (aiderProviderFailure(text) !== null) retrying = false;
    } else if (retrying && line.trim() && !line.startsWith("#### ") && !line.startsWith("# ")) {
      diagnostics = [];
      retrying = false;
    }
  }
  return aiderProviderFailure(diagnostics.join("\n"));
}
