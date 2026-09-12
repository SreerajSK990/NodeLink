export default async function* cleanReporter(source) {
  for await (const event of source) {
    if (event.type === 'test:pass') {
      yield `- PASS: ${event.data.name} (${event.data.details.duration_ms.toFixed(2)}ms)\n`
    } else if (event.type === 'test:fail') {
      yield `- FAIL: ${event.data.name}\n`
      if (event.data.details?.error) {
        yield `  Error: ${event.data.details.error.message}\n`
      }
    } else if (event.type === 'test:summary') {
      const counts = event.data.counts
      yield `\n- SUMMARY: total: ${counts.tests} | passed: ${counts.passed} | failed: ${counts.failed}\n`
    }
  }
}
