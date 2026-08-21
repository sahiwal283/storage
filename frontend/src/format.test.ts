import { describe, expect, it } from "vitest";
import { createdBySubtitle } from "./format";

describe("createdBySubtitle", () => {
  it("labels files as uploaded by", () => {
    expect(
      createdBySubtitle({ type: "file", created_by: "Sahil" })
    ).toBe("Uploaded by Sahil");
  });

  it("labels folders as created by", () => {
    expect(
      createdBySubtitle({ type: "folder", created_by: "Sahil" })
    ).toBe("Created by Sahil");
  });

  it("returns null when created_by is missing", () => {
    expect(createdBySubtitle({ type: "file", created_by: null })).toBeNull();
  });
});
