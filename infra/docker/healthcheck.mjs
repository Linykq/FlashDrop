// Container healthcheck for the `node` and `web` images: `node healthcheck.mjs <url>` exits 0 when the URL
// answers 2xx within the timeout. The slim base image has no curl or wget, and Node's own fetch keeps the
// check free of dependencies. Compose sets the URL per service (compose.yaml).

const [url] = process.argv.slice(2);
if (url === undefined) {
  console.error('usage: node healthcheck.mjs <url>');
  process.exit(2);
}

try {
  // Shorter than the Compose healthcheck timeout, so a hung server fails here, with a reason in the log.
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_500) });
  // Only the status matters. Cancelling the body matters for streamed pages, whose body can stay open
  // until the page's slowest dynamic part has rendered.
  await response.body?.cancel();
  if (!response.ok) {
    console.error(`${url} answered ${response.status}`);
    process.exit(1);
  }
} catch (error) {
  // fetch reports a network failure as "fetch failed" with the actual reason (ECONNREFUSED...) as its cause.
  const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  console.error(`${url} is unreachable: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
}
