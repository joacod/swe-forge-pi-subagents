import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";

/** The two access modes supported by the shared checkout lock. */
export type CheckoutAccess = "READ_ONLY" | "WRITABLE";

/** A held checkout lock. Release is idempotent so cleanup paths can be defensive. */
export interface CheckoutLease {
	readonly checkout: string;
	readonly access: CheckoutAccess;
	release(): void;
}

type LeaseResolver = (lease: CheckoutLease) => void;
type LeaseRejecter = (reason?: unknown) => void;

interface Waiter {
	readonly access: CheckoutAccess;
	readonly resolve: LeaseResolver;
	readonly reject: LeaseRejecter;
	readonly signal?: AbortSignal;
	settled: boolean;
	onAbort?: () => void;
}

interface CheckoutState {
	activeReaders: number;
	writerActive: boolean;
	waiters: Waiter[];
}

/**
 * Normalize a cwd before using it as a lock identity.
 *
 * Existing symlink aliases are collapsed so `/project` and `/link-to-project`
 * cannot acquire independent in-process locks. A not-yet-created path keeps a
 * lexical identity; the runtime rejects such paths before spawning a child.
 */
export function normalizeCheckout(cwd: string): string {
	if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
		throw new TypeError("Checkout path must be a non-empty filesystem path without NUL bytes.");
	}

	const resolved = normalize(resolve(cwd));
	try {
		return normalize(realpathSync.native(resolved));
	} catch {
		return resolved;
	}
}

function isCheckoutAccess(value: unknown): value is CheckoutAccess {
	return value === "READ_ONLY" || value === "WRITABLE";
}

function abortError(): Error {
	const error = new Error("The checkout lock acquisition was aborted.");
	error.name = "AbortError";
	return error;
}

/** Identify the abort rejection produced by a queued checkout acquisition. */
export function isCheckoutAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * A small in-memory, per-checkout shared-read/exclusive-write lock.
 *
 * Waiters are FIFO, except that a run of readers at the front of the queue is
 * admitted together. Once a writer is queued, later readers remain queued
 * behind it, preventing an active stream of readers from starving the writer.
 */
export class CheckoutScheduler {
	private readonly checkouts = new Map<string, CheckoutState>();

	/** Acquire a read or write lease for one normalized checkout. */
	acquire(cwd: string, access: CheckoutAccess, signal?: AbortSignal): Promise<CheckoutLease> {
		if (!isCheckoutAccess(access)) {
			return Promise.reject(new TypeError(`Unsupported checkout access mode: ${String(access)}`));
		}
		if (signal?.aborted) return Promise.reject(abortError());

		const checkout = normalizeCheckout(cwd);
		let resolveLease!: LeaseResolver;
		let rejectLease!: LeaseRejecter;
		const promise = new Promise<CheckoutLease>((resolvePromise, rejectPromise) => {
			resolveLease = resolvePromise;
			rejectLease = rejectPromise;
		});
		const state = this.checkouts.get(checkout) ?? {
			activeReaders: 0,
			writerActive: false,
			waiters: [],
		};
		this.checkouts.set(checkout, state);

		const waiter: Waiter = {
			access,
			resolve: resolveLease,
			reject: rejectLease,
			signal,
			settled: false,
		};
		const onAbort = () => this.cancelWaiter(checkout, state, waiter);
		waiter.onAbort = onAbort;
		signal?.addEventListener("abort", onAbort, { once: true });
		state.waiters.push(waiter);

		// Abort can be delivered between the initial check and listener setup.
		if (signal?.aborted) onAbort();
		else this.drain(checkout, state);

		return promise;
	}

	/** Run one operation while holding the checkout lease. */
	async run<T>(
		cwd: string,
		access: CheckoutAccess,
		operation: () => T | PromiseLike<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const lease = await this.acquire(cwd, access, signal);
		try {
			return await operation();
		} finally {
			lease.release();
		}
	}

	private cancelWaiter(checkout: string, state: CheckoutState, waiter: Waiter): void {
		if (waiter.settled) return;

		const index = state.waiters.indexOf(waiter);
		if (index >= 0) state.waiters.splice(index, 1);
		waiter.settled = true;
		this.detachAbortListener(waiter);
		waiter.reject(abortError());
		this.drain(checkout, state);
	}

	private grantWaiter(checkout: string, state: CheckoutState, waiter: Waiter): void {
		if (waiter.settled) return;

		waiter.settled = true;
		this.detachAbortListener(waiter);
		if (waiter.access === "READ_ONLY") state.activeReaders += 1;
		else state.writerActive = true;

		let released = false;
		const lease: CheckoutLease = {
			checkout,
			access: waiter.access,
			release: () => {
				if (released) return;
				released = true;
				if (waiter.access === "READ_ONLY") state.activeReaders -= 1;
				else state.writerActive = false;
				this.drain(checkout, state);
			},
		};
		waiter.resolve(lease);
	}

	private drain(checkout: string, state: CheckoutState): void {
		while (!state.writerActive) {
			const next = state.waiters[0];
			if (!next) break;

			if (next.access === "WRITABLE") {
				// A writer waits for every active reader and then owns the checkout
				// exclusively. Readers behind it stay queued until it releases.
				if (state.activeReaders > 0) break;
				state.waiters.shift();
				this.grantWaiter(checkout, state, next);
				break;
			}

			// Admit all leading readers together. A writer encountered at the
			// front of the remaining queue stops the loop and closes the gate to
			// newly arriving readers until that writer has run.
			state.waiters.shift();
			this.grantWaiter(checkout, state, next);
		}

		if (state.activeReaders === 0 && !state.writerActive && state.waiters.length === 0) {
			this.checkouts.delete(checkout);
		}
	}

	private detachAbortListener(waiter: Waiter): void {
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.onAbort = undefined;
	}
}

/** The process-wide scheduler used by the child execution runtime. */
export const checkoutScheduler = new CheckoutScheduler();

/** Convenience wrapper for callers that do not need to retain a lease. */
export function withCheckoutLock<T>(
	cwd: string,
	access: CheckoutAccess,
	operation: () => T | PromiseLike<T>,
	signal?: AbortSignal,
	scheduler: CheckoutScheduler = checkoutScheduler,
): Promise<T> {
	return scheduler.run(cwd, access, operation, signal);
}
