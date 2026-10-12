// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineNotice, errorText } from "./InlineNotice";

describe("InlineNotice", () => {
  it("errors are announced as alerts; info and warning as status", () => {
    render(
      <>
        <InlineNotice tone="error">bad</InlineNotice>
        <InlineNotice tone="warning">careful</InlineNotice>
        <InlineNotice>fyi</InlineNotice>
      </>,
    );
    expect(screen.getByRole("alert").textContent).toBe("bad");
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toEqual(["careful", "fyi"]);
  });

  it("shows an action beside the text", () => {
    render(<InlineNotice action={<button type="button">Retry</button>}>failed</InlineNotice>);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("errorText", () => {
  it("is readable for any thrown value", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText({ message: "from object" })).toBe("from object");
    expect(errorText({ code: 5 })).toBe('{"code":5}');
    expect(errorText(undefined)).toBe("undefined");
  });
});
