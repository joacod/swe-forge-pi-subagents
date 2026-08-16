import { test } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { CheckoutScheduler } from "../src/checkout-scheduler.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function checkoutPath(name: string): string {
	return join(tmpdir(), `swe-forge-checkout-scheduler-${process.pid}`, name);
}

test("allows two readers to overlap in one checkout", async () => {
	const scheduler = new CheckoutScheduler();
	const firstStarted = deferred();
	const firstRelease = deferred();
	let firstActive = false;
	let secondSawFirstActive = false;

	const first = scheduler.run(checkoutPath("shared"), "READ_ONLY", async () => {
		firstActive = true;
		firstStarted.resolve();
		await firstRelease.promise;
		firstActive = false;
	});
	await firstStarted.promise;

	await scheduler.run(checkoutPath("shared"), "READ_ONLY", async () => {
		secondSawFirstActive = firstActive;
	});

	assert.equal(secondSawFirstActive, true);
	firstRelease.resolve();
	await first;
});

test("serializes two writers in one checkout", async () => {
	const scheduler = new CheckoutScheduler();
	const firstStarted = deferred();
	const firstRelease = deferred();
	const order: string[] = [];

	const first = scheduler.run(checkoutPath("shared"), "WRITABLE", async () => {
		order.push("first-start");
		firstStarted.resolve();
		await firstRelease.promise;
		order.push("first-end");
	});
	await firstStarted.promise;

	const second = scheduler.run(checkoutPath("shared"), "WRITABLE", async () => {
		order.push("second-start");
		order.push("second-end");
	});
	assert.deepEqual(order, ["first-start"]);

	firstRelease.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});

test("waits for active readers before starting a writer", async () => {
	const scheduler = new CheckoutScheduler();
	const readerStarted = deferred();
	const readerRelease = deferred();
	let writerStarted = false;

	const reader = scheduler.run(checkoutPath("shared"), "READ_ONLY", async () => {
		readerStarted.resolve();
		await readerRelease.promise;
	});
	await readerStarted.promise;

	const writer = scheduler.run(checkoutPath("shared"), "WRITABLE", async () => {
		writerStarted = true;
	});
	assert.equal(writerStarted, false);

	readerRelease.resolve();
	await Promise.all([reader, writer]);
	assert.equal(writerStarted, true);
});

test("waits for an active writer before starting a reader", async () => {
	const scheduler = new CheckoutScheduler();
	const writerStarted = deferred();
	const writerRelease = deferred();
	let readerStarted = false;

	const writer = scheduler.run(checkoutPath("shared"), "WRITABLE", async () => {
		writerStarted.resolve();
		await writerRelease.promise;
	});
	await writerStarted.promise;

	const reader = scheduler.run(checkoutPath("shared"), "READ_ONLY", async () => {
		readerStarted = true;
	});
	assert.equal(readerStarted, false);

	writerRelease.resolve();
	await Promise.all([writer, reader]);
	assert.equal(readerStarted, true);
});

test("removes a canceled waiter from the checkout queue", async () => {
	const scheduler = new CheckoutScheduler();
	const readerStarted = deferred();
	const readerRelease = deferred();
	const cancellation = new AbortController();

	const reader = scheduler.run(checkoutPath("shared"), "READ_ONLY", async () => {
		readerStarted.resolve();
		await readerRelease.promise;
	});
	await readerStarted.promise;

	const writer = scheduler.run(checkoutPath("shared"), "WRITABLE", async () => {
		assert.fail("the canceled writer must never run");
	}, cancellation.signal);
	cancellation.abort();
	await assert.rejects(writer, (error: unknown) => error instanceof Error && error.name === "AbortError");

	let laterReaderStarted = false;
	const laterReader = scheduler.run(checkoutPath("shared"), "READ_ONLY", async () => {
		laterReaderStarted = true;
	});
	await laterReader;
	assert.equal(laterReaderStarted, true);

	readerRelease.resolve();
	await reader;
});

test("releases a writer when its operation throws", async () => {
	const scheduler = new CheckoutScheduler();
	const failure = new Error("worker failed");

	await assert.rejects(
		scheduler.run(checkoutPath("shared"), "WRITABLE", () => {
			throw failure;
		}),
		(error: unknown) => error === failure,
	);

	let followUpStarted = false;
	await scheduler.run(checkoutPath("shared"), "WRITABLE", () => {
		followUpStarted = true;
	});
	assert.equal(followUpStarted, true);
});

test("does not block a different checkout", async () => {
	const scheduler = new CheckoutScheduler();
	const firstStarted = deferred();
	const firstRelease = deferred();
	let secondStarted = false;
	const firstCheckout = checkoutPath("one");
	const equivalentFirstCheckout = `${firstCheckout}${sep}nested${sep}..`;

	const first = scheduler.run(equivalentFirstCheckout, "WRITABLE", async () => {
		firstStarted.resolve();
		await firstRelease.promise;
	});
	await firstStarted.promise;

	await scheduler.run(checkoutPath("two"), "WRITABLE", () => {
		secondStarted = true;
	});
	assert.equal(secondStarted, true);

	firstRelease.resolve();
	await first;
});

test("prevents new readers from starving a queued writer", async () => {
	const scheduler = new CheckoutScheduler();
	const initialReaderStarted = deferred();
	const initialReaderRelease = deferred();
	const writerStarted = deferred();
	const writerRelease = deferred();
	const events: string[] = [];

	const initialReader = scheduler.run(checkoutPath("shared"), "READ_ONLY", async () => {
		events.push("initial-reader");
		initialReaderStarted.resolve();
		await initialReaderRelease.promise;
	});
	await initialReaderStarted.promise;

	const writer = scheduler.run(checkoutPath("shared"), "WRITABLE", async () => {
		events.push("writer");
		writerStarted.resolve();
		await writerRelease.promise;
	});
	const readers = Array.from({ length: 8 }, (_, index) =>
		scheduler.run(checkoutPath("shared"), "READ_ONLY", () => {
			events.push(`reader-${index}`);
		}),
	);

	await nextTurn();
	assert.deepEqual(events, ["initial-reader"]);

	initialReaderRelease.resolve();
	await writerStarted.promise;
	assert.deepEqual(events, ["initial-reader", "writer"]);

	writerRelease.resolve();
	await Promise.all([initialReader, writer, ...readers]);
	assert.deepEqual(events.slice(0, 2), ["initial-reader", "writer"]);
});
