import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import {
  ChatHistoryItem,
  ChatMessage,
  InputModifiers,
  MessageContent,
  SlashCommandDescription,
} from "core";
import { constructMessages } from "core/llm/constructMessages";
import { renderChatMessage } from "core/util/messageContent";
import posthog from "posthog-js";
import { defaultModelSelector } from "../selectors/modelSelectors";
import {
  initNewActiveMessage,
  resubmitAtIndex,
  setCurCheckpointIndex,
  setMessageAtIndex,
} from "../slices/stateSlice";
import { ThunkApiType } from "../store";
import { gatherContext } from "./gatherContext";
import { handleErrors } from "./handleErrors";
import { resetStateForNewMessage } from "./resetStateForNewMessage";
import { streamNormalInput } from "./streamNormalInput";
import { streamSlashCommand } from "./streamSlashCommand";

const getSlashCommandForInput = (
  input: MessageContent,
  slashCommands: SlashCommandDescription[],
): [SlashCommandDescription, string] | undefined => {
  let slashCommand: SlashCommandDescription | undefined;
  let slashCommandName: string | undefined;

  let lastText =
    typeof input === "string"
      ? input
      : input.filter((part) => part.type === "text").slice(-1)[0]?.text || "";

  if (lastText.startsWith("/")) {
    slashCommandName = lastText.split(" ")[0].substring(1);
    slashCommand = slashCommands.find(
      (command) => command.name === slashCommandName,
    );
  }
  if (!slashCommand || !slashCommandName) {
    return undefined;
  }

  // Convert to actual slash command object with runnable function
  return [slashCommand, renderChatMessage({ role: "user", content: input })];
};

export const streamResponseThunk = createAsyncThunk<
  void,
  {
    editorState: JSONContent;
    modifiers: InputModifiers;
    index?: number;
    promptPreamble?: string;
  },
  ThunkApiType
>(
  "chat/streamResponse",
  async (
    { editorState, modifiers, index, promptPreamble },
    { dispatch, extra, getState },
  ) => {
    await dispatch(
      handleErrors(async () => {
        const state = getState();
        const defaultModel = defaultModelSelector(state);
        const slashCommands = state.state.config.slashCommands || [];
        const inputIndex = index ?? state.state.history.length;

        if (typeof index === "number") {
          dispatch(resubmitAtIndex({ index, editorState }));
        } else {
          dispatch(initNewActiveMessage({ editorState }));
        }

        resetStateForNewMessage();

        if (index) {
          dispatch(setCurCheckpointIndex(Math.floor(index / 2)));
        }

        const result = await dispatch(
          gatherContext({
            editorState,
            modifiers,
            promptPreamble,
          }),
        );
        const unwrapped = unwrapResult(result);
        const { selectedContextItems, selectedCode, content } = unwrapped;

        // Add the message to the history
        const message: ChatMessage = {
          role: "user",
          content,
        };
        const historyItem: ChatHistoryItem = {
          message,
          contextItems: selectedContextItems,
          editorState,
        };

        dispatch(
          setMessageAtIndex({
            message,
            index: inputIndex,
            contextItems: selectedContextItems,
          }),
        );

        // Construct messages from updated history
        const updatedHistory = getState().state.history;
        const messages = constructMessages(updatedHistory, defaultModel.model);

        posthog.capture("step run", {
          step_name: "User Input",
          params: {},
        });
        posthog.capture("userInput", {});

        // Determine if the input is a slash command
        let commandAndInput = getSlashCommandForInput(content, slashCommands);

        if (!commandAndInput) {
          await dispatch(streamNormalInput(messages));
        } else {
          const [slashCommand, commandInput] = commandAndInput;
          let updatedContextItems = [];
          posthog.capture("step run", {
            step_name: slashCommand.name,
            params: {},
          });

          // if (slashCommand.name === "multifile-edit") {
          //   dispatch(setIsInMultifileEdit(true));
          // }

          await dispatch(
            streamSlashCommand({
              messages,
              slashCommand,
              input: commandInput,
              historyIndex: inputIndex,
              selectedCode,
              contextItems: updatedContextItems,
            }),
          );
        }
      }),
    );
  },
);
