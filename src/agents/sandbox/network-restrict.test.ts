import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./docker.js", () => ({
  execDocker: vi.fn(),
}));

vi.mock("./network-restrict-exec.js", () => ({
  execIptables: vi.fn(),
}));

import { execDocker } from "./docker.js";
import { execIptables } from "./network-restrict-exec.js";
import {
  __testing,
  applyNetworkRestrictions,
  removeNetworkRestrictions,
} from "./network-restrict.js";

const mockExecDocker = vi.mocked(execDocker);
const mockExecIptables = vi.mocked(execIptables);

describe("network-restrict", () => {
  beforeEach(() => {
    mockExecDocker.mockReset();
    mockExecIptables.mockReset();
  });

  describe("BLOCKED_RANGES", () => {
    it("includes all required private/reserved ranges", () => {
      const ranges = __testing.BLOCKED_RANGES;
      expect(ranges).toContain("10.0.0.0/8");
      expect(ranges).toContain("172.16.0.0/12");
      expect(ranges).toContain("192.168.0.0/16");
      expect(ranges).toContain("169.254.0.0/16");
      expect(ranges).toContain("127.0.0.0/8");
    });
  });

  describe("applyNetworkRestrictions", () => {
    it("adds iptables rules for each blocked range", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "172.17.0.5", stderr: "", code: 0 });
      // -C (check) returns non-zero = rule doesn't exist
      mockExecIptables.mockImplementation(async (args: string[]) => {
        if (args[0] === "-C") {
          return { code: 1, stdout: "", stderr: "rule not found" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      await applyNetworkRestrictions("test-container");

      // Should call docker inspect for IP
      expect(mockExecDocker).toHaveBeenCalledWith(
        expect.arrayContaining(["inspect", "-f", expect.any(String), "test-container"]),
        { allowFailure: true },
      );

      // Should have checked and inserted a rule for each blocked range
      const insertCalls = mockExecIptables.mock.calls.filter((c) => c[0][0] === "-I");
      expect(insertCalls.length).toBe(__testing.BLOCKED_RANGES.length);

      for (const range of __testing.BLOCKED_RANGES) {
        const matchingCall = insertCalls.find(
          (c) => c[0].includes(range) && c[0].includes("172.17.0.5"),
        );
        expect(matchingCall).toBeTruthy();
      }
    });

    it("skips rule insertion when rule already exists", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "172.17.0.5", stderr: "", code: 0 });
      // -C returns 0 = rule already exists
      mockExecIptables.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

      await applyNetworkRestrictions("test-container");

      const insertCalls = mockExecIptables.mock.calls.filter((c) => c[0][0] === "-I");
      expect(insertCalls.length).toBe(0);
    });

    it("throws when container IP cannot be resolved", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "", stderr: "no such container", code: 1 });

      await expect(applyNetworkRestrictions("missing-container")).rejects.toThrow(
        "Cannot resolve IP",
      );
    });
  });

  describe("removeNetworkRestrictions", () => {
    it("removes existing iptables rules", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "172.17.0.5", stderr: "", code: 0 });
      // -C returns 0 = rule exists
      mockExecIptables.mockImplementation(async (args: string[]) => {
        if (args[0] === "-C") {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      await removeNetworkRestrictions("test-container");

      const deleteCalls = mockExecIptables.mock.calls.filter((c) => c[0][0] === "-D");
      expect(deleteCalls.length).toBe(__testing.BLOCKED_RANGES.length);
    });

    it("does nothing when container has no IP", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 1 });

      await removeNetworkRestrictions("missing-container");

      expect(mockExecIptables).not.toHaveBeenCalled();
    });
  });
});
