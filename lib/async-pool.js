async function mapWithConcurrency(items, concurrency, worker) {
  const safeConcurrency = Math.max(1, Number(concurrency) || 1);
  const results = new Array(items.length);
  let index = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) break;

      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (err) {
        results[currentIndex] = { error: err };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < safeConcurrency; i += 1) {
    workers.push(runWorker());
  }

  await Promise.all(workers);
  return results;
}

module.exports = {
  mapWithConcurrency,
};
