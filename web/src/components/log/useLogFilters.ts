import { useCallback, useEffect, useRef, useState } from "react";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useUrlParams } from "./useUrlParams";

export type RangeValue = [Dayjs | null, Dayjs | null] | null;

/** The URL names these filters travel under (附录 A). */
const PARAM = {
  keyword: "q",
  model: "model",
  token: "token",
  username: "username",
  channel: "channel",
  error: "error",
  start: "start",
  end: "end",
} as const;

interface Seed {
  keyword: string;
  model: string;
  token: string;
  username: string;
  channel: string;
  onlyError: boolean;
  range: RangeValue;
}

const readSeed = (params: URLSearchParams, admin: boolean): Seed => {
  const start = params.get(PARAM.start);
  const end = params.get(PARAM.end);
  const range: RangeValue =
    start && end && dayjs(start).isValid() && dayjs(end).isValid()
      ? [dayjs(start), dayjs(end)]
      : null;
  return {
    keyword: params.get(PARAM.keyword) ?? "",
    model: params.get(PARAM.model) ?? "",
    token: params.get(PARAM.token) ?? "",
    // A regular user has no username filter to begin with, so the parameter
    // is ignored rather than silently narrowing their own logs.
    username: admin ? params.get(PARAM.username) ?? "" : "",
    channel: params.get(PARAM.channel) ?? "",
    onlyError: params.get(PARAM.error) === "1",
    range,
  };
};

/**
 * The filter row's state. Inputs are what the boxes show; the debounced
 * values beside them are what the list and the feed actually query with, so
 * typing stays cheap while the network trails behind.
 *
 * The URL is the second home of the same state: a filtered page can be
 * reloaded, bookmarked and handed to someone else.
 */
export function useLogFilters(admin = false) {
  const { params: searchParams, write } = useUrlParams();
  const seed = useRef(readSeed(searchParams, admin)).current;

  const [keywordInput, setKeywordInput] = useState(seed.keyword);
  const [modelInput, setModelInput] = useState(seed.model);
  const [tokenInput, setTokenInput] = useState(seed.token);
  const [usernameInput, setUsernameInput] = useState(seed.username);
  const [channelInput, setChannelInput] = useState(seed.channel);
  const [onlyError, setOnlyError] = useState(seed.onlyError);
  const [range, setRange] = useState<RangeValue>(seed.range);

  const keyword = useDebouncedValue(keywordInput);
  const model = useDebouncedValue(modelInput);
  const tokenName = useDebouncedValue(tokenInput);
  const username = useDebouncedValue(usernameInput);
  const channelID = useDebouncedValue(channelInput);

  // Gates the 重置 link: nothing is dirty until one of the boxes is used.
  const dirty = Boolean(
    keywordInput ||
      modelInput ||
      tokenInput ||
      usernameInput ||
      channelInput ||
      onlyError ||
      range,
  );

  const reset = useCallback(() => {
    setKeywordInput("");
    setModelInput("");
    setTokenInput("");
    setUsernameInput("");
    setChannelInput("");
    setOnlyError(false);
    setRange(null);
  }, []);

  // What this hook last put into the URL, so a write is not mistaken for
  // somebody else changing the address bar.
  const written = useRef<string | null>(null);

  // The debounced values are what the list queries with, so the URL follows
  // them rather than every keystroke. Defaults are left out: an address bar
  // full of empty parameters is noise.
  useEffect(() => {
    write((next) => {
      const put = (name: string, value: string) => {
        if (value) next.set(name, value);
        else next.delete(name);
      };
      put(PARAM.keyword, keyword);
      put(PARAM.model, model);
      put(PARAM.token, tokenName);
      put(PARAM.username, admin ? username : "");
      put(PARAM.channel, channelID);
      if (onlyError) next.set(PARAM.error, "1");
      else next.delete(PARAM.error);
      if (range) {
        if (range[0]) next.set(PARAM.start, range[0].toISOString());
        else next.delete(PARAM.start);
        if (range[1]) next.set(PARAM.end, range[1].toISOString());
        else next.delete(PARAM.end);
      } else {
        next.delete(PARAM.start);
        next.delete(PARAM.end);
      }
    });
    written.current = searchParams.toString();
  }, [
    admin,
    channelID,
    keyword,
    model,
    onlyError,
    range,
    searchParams,
    tokenName,
    username,
    write,
  ]);

  // Somebody else changed the address (a link to a filtered log, the back
  // button): the boxes follow it.
  useEffect(() => {
    const current = searchParams.toString();
    if (written.current === null || current === written.current) return;
    const next = readSeed(searchParams, admin);
    setKeywordInput(next.keyword);
    setModelInput(next.model);
    setTokenInput(next.token);
    setUsernameInput(next.username);
    setChannelInput(next.channel);
    setOnlyError(next.onlyError);
    setRange(next.range);
  }, [admin, searchParams]);

  return {
    keywordInput,
    setKeywordInput,
    modelInput,
    setModelInput,
    tokenInput,
    setTokenInput,
    usernameInput,
    setUsernameInput,
    channelInput,
    setChannelInput,
    onlyError,
    setOnlyError,
    range,
    setRange,
    keyword,
    model,
    tokenName,
    username,
    channelID,
    dirty,
    reset,
  };
}
