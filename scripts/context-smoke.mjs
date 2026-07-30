import { randomUUID } from 'node:crypto';
import { loadConfig } from '../dist/config.js';
import { QueryEngine } from '../dist/engine.js';
import { createProvider } from '../dist/providers/factory.js';

const SIMULATED_WINDOW_TOKENS = 16_384;
const INITIAL_WINDOW_TOKENS = 100_000;
const FILLER_CHARACTERS = 24_000;

function withControllableContextWindow(provider, initialContextWindowTokens) {
  let contextWindowTokens = initialContextWindowTokens;
  return {
    provider: {
      chat: provider.chat.bind(provider),
      ...(provider.chatStream ? { chatStream: provider.chatStream.bind(provider) } : {}),
      getInfo() {
        return {
          ...provider.getInfo(),
          contextWindowTokens
        };
      }
    },
    setContextWindow(nextContextWindowTokens) {
      contextWindowTokens = nextContextWindowTokens;
    }
  };
}

async function collectTurn(turn) {
  const events = [];
  while (true) {
    const next = await turn.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

async function main() {
  const config = loadConfig();
  const providerConfig = config.providers[config.currentProvider];
  if (!providerConfig) {
    throw new Error(`Current provider is not configured: ${config.currentProvider}`);
  }

  const controlledProvider = withControllableContextWindow(
    createProvider(providerConfig),
    INITIAL_WINDOW_TOKENS
  );
  const engine = new QueryEngine({
    provider: controlledProvider.provider,
    tools: [],
    audit: false,
    context: {
      autoCompact: true,
      defaultWindowTokens: SIMULATED_WINDOW_TOKENS
    }
  });
  const marker = `CTX-SMOKE-${randomUUID().slice(0, 8)}`;
  await engine.chat(
    `Remember this exact marker: ${marker}. Reply only ACK. ` +
      `Filler: ${'A'.repeat(FILLER_CHARACTERS)}`
  );
  controlledProvider.setContextWindow(SIMULATED_WINDOW_TOKENS);

  const { events, result } = await collectTurn(
    engine.runTurn('Reply with only the exact marker from the previous turn.')
  );
  const compactions = events.filter((event) => event.type === 'compaction_completed');
  const finalCompaction = compactions.at(-1);
  const terminal = events.at(-1)?.type;
  const markerPreserved = result.status === 'completed' && result.response.includes(marker);
  const passed =
    result.status === 'completed' &&
    markerPreserved &&
    compactions.length > 0 &&
    finalCompaction.afterTokens < finalCompaction.beforeTokens &&
    terminal === 'turn_completed';

  const providerInfo = controlledProvider.provider.getInfo();
  const providerFailures = events
    .filter((event) => event.type === 'provider_request_failed')
    .map((event) => ({
      purpose: event.purpose,
      attempt: event.attempt,
      code: event.error.code,
      status: event.error.status,
      willRetry: event.willRetry
    }));
  process.stdout.write(
    `${JSON.stringify(
      {
        passed,
        provider: providerInfo.name,
        model: providerInfo.model,
        simulatedWindowTokens: SIMULATED_WINDOW_TOKENS,
        status: result.status,
        markerPreserved,
        compactions: compactions.length,
        beforeTokens: finalCompaction?.beforeTokens,
        afterTokens: finalCompaction?.afterTokens,
        compactionRequests: events.filter(
          (event) => event.type === 'provider_request_started' && event.purpose === 'compaction'
        ).length,
        errorCode: result.status === 'failed' ? result.error.code : undefined,
        providerFailures,
        terminal
      },
      null,
      2
    )}\n`
  );

  if (!passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Context smoke test failed: ${reason}\n`);
  process.exitCode = 1;
});
