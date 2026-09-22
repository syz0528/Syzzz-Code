export function anthropicEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function anthropicEvents(message) {
  const events = [
    {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 0 }
      }
    }
  ];
  for (const [index, block] of message.content.entries()) {
    events.push({
      type: 'content_block_start',
      index,
      content_block: {
        ...block,
        ...(block.type === 'text' ? { text: '' } : { input: {} })
      }
    });
    const value = block.type === 'text' ? block.text : JSON.stringify(block.input);
    const split = Math.max(1, Math.floor(value.length / 2));
    for (const part of [value.slice(0, split), value.slice(split)]) {
      events.push({
        type: 'content_block_delta',
        index,
        delta:
          block.type === 'text'
            ? { type: 'text_delta', text: part }
            : { type: 'input_json_delta', partial_json: part }
      });
    }
    events.push({ type: 'content_block_stop', index });
  }
  events.push({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: message.usage
  });
  events.push({ type: 'message_stop' });
  return events;
}

export function writeAnthropicSse(response, message, headers = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
  response.end(anthropicEvents(message).map(anthropicEvent).join(''));
}
