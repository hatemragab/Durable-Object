import { describe, expect, jest, test } from "@jest/globals";
import { ConsoleLogger } from "@nestjs/common";
import { SafeConsoleLogger, safeErrorCode } from "../src/common/logging.js";

describe("safe console output", () => {
  test("redacts configured credentials, bearer tokens, ticket URLs and controls", () => {
    const output = jest
      .spyOn(ConsoleLogger.prototype, "log")
      .mockImplementation(() => {});
    try {
      const logger = new SafeConsoleLogger(["configured-private-value"]);
      logger.log(
        "Ready configured-private-value Bearer unknown-token https://host/v1/ws?ticket=private-ticket\nInjected",
        "Bootstrap",
      );
      expect(output).toHaveBeenCalled();
      const text = String(output.mock.calls[0]?.[0]);
      expect(text).toContain("[REDACTED]");
      expect(text).toContain("[URL omitted]");
      for (const secret of [
        "configured-private-value",
        "unknown-token",
        "private-ticket",
        "\n",
      ])
        expect(text).not.toContain(secret);
      logger.log(
        { private: "unconfigured-private-text" },
        { authorization: "private-header" },
      );
      expect(output.mock.calls.at(-1)).toEqual([
        "[Non-text log omitted]",
        "API",
      ]);
    } finally {
      output.mockRestore();
    }
  });
  test("never serializes raw exceptions, stacks or their context", () => {
    const output = jest
      .spyOn(ConsoleLogger.prototype, "error")
      .mockImplementation(() => {});
    try {
      const logger = new SafeConsoleLogger();
      logger.error(
        new Error("private-message"),
        "private-stack",
        "mongodb://user:password@host/database",
      );
      const text = JSON.stringify(output.mock.calls);
      for (const secret of ["private-message", "private-stack", "password"])
        expect(text).not.toContain(secret);
      expect(text).toContain("Backend operation failed");
    } finally {
      output.mockRestore();
    }
  });
  test("error codes accept only bounded code labels", () => {
    expect(safeErrorCode("DEPENDENCY_UNAVAILABLE")).toBe(
      "DEPENDENCY_UNAVAILABLE",
    );
    expect(safeErrorCode("TOKEN\nprivate")).toBe("INTERNAL_ERROR");
    expect(safeErrorCode({ private: true })).toBe("INTERNAL_ERROR");
  });
});
