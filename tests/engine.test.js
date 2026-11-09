import { describe, expect, it, vi } from "vitest";
import { describeError, gpuWithFallback } from "../src/pipeline/engine.js";

describe("engine error handling", () => {
	it("never describes an error as empty", () => {
		expect(describeError(new Error(""))).toBe("Error");
		expect(describeError(new Error("boom"))).toBe("boom");
		expect(describeError(12345)).toBe("12345");
		expect(describeError(undefined)).toBe("unknown error");
	});

	it("moves a session to WASM when a WebGPU run fails, and stays there", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const gpu = {
			run: vi.fn().mockRejectedValue(new Error("buffer too large")),
		};
		const wasm = { run: vi.fn().mockResolvedValue({ out: 1 }) };
		const rt = {
			InferenceSession: { create: vi.fn().mockResolvedValue(wasm) },
		};
		const session = gpuWithFallback(rt, new Uint8Array(1), gpu);
		expect(await session.run({ x: 1 })).toEqual({ out: 1 });
		expect(await session.run({ x: 2 })).toEqual({ out: 1 });
		expect(gpu.run).toHaveBeenCalledTimes(1);
		expect(rt.InferenceSession.create).toHaveBeenCalledWith(
			expect.any(Uint8Array),
			{
				executionProviders: ["wasm"],
			},
		);
		expect(wasm.run).toHaveBeenCalledTimes(2);
	});
});
