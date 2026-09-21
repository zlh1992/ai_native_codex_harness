import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// Only numerical provider usage crosses this boundary; no SSE text is retained.
export function createLocalUsageMeter(send) {
  const scope = new AsyncLocalStorage();
  async function* stream(options, next) {
    const iterator = next()[Symbol.asyncIterator]();
    try {
      while (true) {
        const value = await scope.run(options.purpose === 'compaction' ? 'compaction' : 'root', () => iterator.next());
        if (value.done) break;
        yield value.value;
      }
    } finally { await iterator.return?.(); }
  }
  async function fetchMetered(nativeFetch, target, options) {
    const id = randomUUID(), kind = scope.getStore() || 'root';
    send({ type: 'usage_start', id, kind });
    let finished = false;
    const finish = () => { if (!finished) { finished = true; send({ type: 'usage_end', id }); } };
    let response;
    try { response = await nativeFetch(target, options); } catch (error) { finish(); throw error; }
    if (!response.ok || !response.body) { finish(); return response; }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    function line(value) {
      if (!value.startsWith('data:')) return;
      let packet; try { packet = JSON.parse(value.slice(5)); } catch { return; }
      const usage = packet.usage;
      if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens)) return;
      // OpenAI-compatible prompt_tokens already includes cached input; DSH/pi-ai
      // uses uncached input plus cache buckets. Send normalized inclusive counts.
      send({ type: 'usage_sample', id, usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
        cacheWriteInputTokens: usage.prompt_tokens_details?.cache_write_tokens ?? 0,
        reasoningOutputTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens } });
    }
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) { if (buffer) line(buffer); finish(); controller.close(); return; }
          buffer += decoder.decode(result.value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, index).trimEnd()); buffer = buffer.slice(index + 1); }
          // Never retain an unbounded provider frame. Oversized data is not usage.
          if (buffer.length > 65536) buffer = '';
          controller.enqueue(result.value);
        } catch (error) { finish(); controller.error(error); }
      },
      async cancel(reason) { finish(); await reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return { stream, fetchMetered };
}
