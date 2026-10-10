// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTerminal } from "../SessionTerminal";
import { ScratchPad } from "./ScratchPad";
import { useChatImages, type ChatImagesProps } from "../attachments/useChatImages";
import { attachmentAdd, attachmentRemove } from "../bridge";

vi.mock("../bridge", () => ({
  attachmentAdd: vi.fn(),
  attachmentRemove: vi.fn(async () => {}),
}));

const png = () => new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });

const terminalBase = {
  title: "Developer",
  cwd: "/w/app",
  sessionId: "s1",
  segments: [],
  promptInFlight: false,
  followUp: "",
  busy: false,
  canSendFollowUp: true,
  promptError: null,
  permissionRequest: null,
  onPermissionSelect: () => {},
  onPermissionCancel: () => {},
  onCancelTurn: () => {},
  onFollowUpChange: () => {},
  onSendFollowUp: () => {},
  onStop: () => {},
};

function images(over: Partial<ChatImagesProps> = {}): ChatImagesProps {
  return { items: [], error: null, onAddFiles: vi.fn(), onRemove: vi.fn(), ...over };
}

const chip = {
  id: "img_1",
  name: "screenshot.png",
  mime: "image/png",
  bytes: 3,
  previewUrl: "data:image/png;base64,AQID",
};

describe("attachment chips in the chat composer", () => {
  it("pasting an image hands the file over and keeps the text paste default", () => {
    const props = images();
    render(<SessionTerminal {...terminalBase} images={props} />);
    const input = screen.getByRole("textbox", { name: "Follow-up message" });
    const file = png();
    fireEvent.paste(input, { clipboardData: { files: [file], items: [] } });
    expect(props.onAddFiles).toHaveBeenCalledWith([file]);
    fireEvent.paste(input, { clipboardData: { files: [], items: [] } });
    expect(props.onAddFiles).toHaveBeenCalledTimes(1);
  });

  it("dropping an image attaches it", () => {
    const props = images();
    render(<SessionTerminal {...terminalBase} images={props} />);
    const file = png();
    fireEvent.drop(screen.getByRole("textbox", { name: "Follow-up message" }), {
      dataTransfer: { files: [file], items: [], types: ["Files"] },
    });
    expect(props.onAddFiles).toHaveBeenCalledWith([file]);
  });

  it("shows thumbnails, removes with ×, and lets an image-only message send", () => {
    const props = images({ items: [chip] });
    const onSend = vi.fn();
    render(<SessionTerminal {...terminalBase} images={props} onSendFollowUp={onSend} />);
    expect(screen.getByRole("list", { name: "Attached images" }).textContent).toContain(
      "screenshot.png",
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot.png" }));
    expect(props.onRemove).toHaveBeenCalledWith("img_1");
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalled();
  });

  it("shows the limits message", () => {
    render(
      <SessionTerminal
        {...terminalBase}
        images={images({ error: "At most 5 images can go with one message." })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("At most 5 images can go with one message.");
  });

  it("offers nothing without image support", () => {
    render(<SessionTerminal {...terminalBase} />);
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("renders a transcript marker as a placeholder in the user bubble", () => {
    render(
      <SessionTerminal
        {...terminalBase}
        segments={[{ id: "u1", kind: "user", text: "Why?\n\n[image: my_bug_1.png]" }]}
      />,
    );
    // Underscores in the name stay literal (no emphasis).
    expect(screen.getByText("🖼 my_bug_1.png")).toBeTruthy();
  });
});

describe("attachment chips in the scratch pad", () => {
  const padBase = {
    content: "",
    truncated: false,
    persistError: null,
    chain: null,
    disabled: false,
    onChange: () => {},
    onTransfer: () => {},
    onSend: () => {},
    onStopChain: () => {},
  };

  it("chat pad takes pasted images and shows chips", () => {
    const props = images({ items: [chip] });
    render(<ScratchPad {...padBase} images={props} />);
    const file = png();
    fireEvent.paste(screen.getByLabelText("Scratch pad editor"), {
      clipboardData: { files: [file], items: [] },
    });
    expect(props.onAddFiles).toHaveBeenCalledWith([file]);
    expect(screen.getByRole("button", { name: "Remove screenshot.png" })).toBeTruthy();
  });

  it("terminal pad never attaches", () => {
    const props = images({ items: [chip] });
    render(<ScratchPad {...padBase} mode="terminal" images={props} />);
    fireEvent.paste(screen.getByLabelText("Scratch pad editor"), {
      clipboardData: { files: [png()], items: [] },
    });
    expect(props.onAddFiles).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
  });
});

describe("useChatImages", () => {
  beforeEach(() => {
    let n = 0;
    vi.mocked(attachmentAdd).mockReset();
    vi.mocked(attachmentAdd).mockImplementation(async (_tab, mime) => ({
      id: `img_${++n}`,
      mime,
      bytes: 3,
    }));
    vi.mocked(attachmentRemove).mockClear();
  });

  it("stages pasted images, enforces five per message, and take() empties the tab", async () => {
    const { result } = renderHook(() => useChatImages());
    await act(() => result.current.actions.addFiles("tab_1", [png(), png(), png()]));
    expect(attachmentAdd).toHaveBeenCalledWith("tab_1", "image/png", "AQID");
    expect(result.current.propsFor("tab_1").items.map((i) => i.name)).toEqual([
      "screenshot.png",
      "screenshot.png",
      "screenshot.png",
    ]);
    await act(() => result.current.actions.addFiles("tab_1", [png(), png(), png()]));
    expect(result.current.propsFor("tab_1").items).toHaveLength(5);
    expect(result.current.propsFor("tab_1").error).toBe(
      "At most 5 images can go with one message.",
    );
    expect(result.current.propsFor("tab_2").items).toHaveLength(0);

    act(() => result.current.propsFor("tab_1").onRemove("img_1"));
    expect(attachmentRemove).toHaveBeenCalledWith("tab_1", "img_1");
    expect(result.current.propsFor("tab_1").items).toHaveLength(4);

    let taken: { id: string }[] = [];
    act(() => {
      taken = result.current.actions.take("tab_1");
    });
    expect(taken.map((i) => i.id)).toEqual(["img_2", "img_3", "img_4", "img_5"]);
    expect(result.current.actions.has("tab_1")).toBe(false);
    act(() => result.current.actions.restore("tab_1", taken as never));
    await waitFor(() => expect(result.current.propsFor("tab_1").items).toHaveLength(4));
  });

  it("shows the backend error when staging fails", async () => {
    vi.mocked(attachmentAdd).mockRejectedValueOnce(new Error("Images must be 5 MB or smaller"));
    const { result } = renderHook(() => useChatImages());
    await act(() => result.current.actions.addFiles("tab_1", [png()]));
    expect(result.current.propsFor("tab_1").error).toBe("Images must be 5 MB or smaller");
    expect(result.current.propsFor("tab_1").items).toHaveLength(0);
  });
});
