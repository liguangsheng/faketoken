import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useSettings } from "../../settings/SettingsContext";
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
  // Set by a link from a call or a session, never typed: there is no box.
  session: "session",
  page: "page",
  size: "size",
} as const;

// The list endpoints clamp page_size at 200. A larger size from the address
// would draw 200 rows a page while the pager counts pages of the larger size,
// and the rows in between could never be reached.
const MAX_PAGE_SIZE = 200;

/** The boxes that are typed into. */
interface Typed {
  keyword: string;
  model: string;
  token: string;
  username: string;
  channel: string;
}

const EMPTY: Typed = { keyword: "", model: "", token: "", username: "", channel: "" };

const sameTyped = (a: Typed, b: Typed) =>
  a.keyword === b.keyword &&
  a.model === b.model &&
  a.token === b.token &&
  a.username === b.username &&
  a.channel === b.channel;

// "3" → 3; anything else (missing, "0", "abc", "2.5") → undefined.
const positive = (raw: string | null) => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

/**
 * The filter row's state, and the page it lands on.
 *
 * The address is the state. What the list queries with is read from it, so a
 * filtered page can be reloaded, bookmarked and handed to someone else, and a
 * link or the back button is just a new address — there is no second copy to
 * drift from it. The one copy kept here is what the text boxes show: it
 * reaches the address once typing pauses, so the network trails behind.
 */
export function useLogFilters(admin = false) {
  const { params, write } = useUrlParams();
  const { defaultPageSize } = useSettings();

  const keyword = params.get(PARAM.keyword) ?? "";
  const model = params.get(PARAM.model) ?? "";
  const tokenName = params.get(PARAM.token) ?? "";
  // A regular user has no username filter to begin with, so the parameter
  // is ignored rather than silently narrowing their own logs.
  const username = admin ? (params.get(PARAM.username) ?? "") : "";
  const channelID = params.get(PARAM.channel) ?? "";
  const onlyError = params.get(PARAM.error) === "1";
  const session = params.get(PARAM.session) ?? "";
  const start = params.get(PARAM.start) ?? "";
  const end = params.get(PARAM.end) ?? "";
  // Keyed on the strings: a fresh pair of dayjs objects on every address
  // change would read as a new range and reload the list.
  const range = useMemo<RangeValue>(
    () =>
      start && end && dayjs(start).isValid() && dayjs(end).isValid()
        ? [dayjs(start), dayjs(end)]
        : null,
    [start, end],
  );
  const page = positive(params.get(PARAM.page)) ?? 1;
  const pageSize = Math.min(
    positive(params.get(PARAM.size)) ?? defaultPageSize,
    MAX_PAGE_SIZE,
  );

  // Writes filter parameters, "" removing one. A filter that changed sends the
  // list back to page 1 in the same write: one reload, not two.
  const writeFilters = useCallback(
    (values: Record<string, string>) =>
      write((next) => {
        let changed = false;
        for (const [name, value] of Object.entries(values)) {
          if ((next.get(name) ?? "") === value) continue;
          changed = true;
          if (value) next.set(name, value);
          else next.delete(name);
        }
        if (changed) next.delete(PARAM.page);
      }),
    [write],
  );

  const applied = useMemo<Typed>(
    () => ({ keyword, model, token: tokenName, username, channel: channelID }),
    [channelID, keyword, model, tokenName, username],
  );
  const [typed, setTyped] = useState<Typed>(applied);
  const settled = useDebouncedValue(typed);

  // What the boxes last put into the address, so their own write coming back
  // is not mistaken for somebody else changing it.
  const written = useRef(applied);

  useEffect(() => {
    writeFilters({
      [PARAM.keyword]: settled.keyword,
      [PARAM.model]: settled.model,
      [PARAM.token]: settled.token,
      [PARAM.username]: admin ? settled.username : "",
      [PARAM.channel]: settled.channel,
    });
    written.current = settled;
  }, [admin, settled, writeFilters]);

  // Somebody else changed the address (a link to a filtered log, the back
  // button): the boxes follow it.
  useEffect(() => {
    if (sameTyped(applied, written.current)) return;
    written.current = applied;
    setTyped(applied);
  }, [applied]);

  const typeInto = useMemo(() => {
    const field = (name: keyof Typed) => (value: string) =>
      setTyped((current) => ({ ...current, [name]: value }));
    return {
      setKeywordInput: field("keyword"),
      setModelInput: field("model"),
      setTokenInput: field("token"),
      setUsernameInput: field("username"),
      setChannelInput: field("channel"),
    };
  }, []);

  const setOnlyError = useCallback(
    (value: boolean) => writeFilters({ [PARAM.error]: value ? "1" : "" }),
    [writeFilters],
  );

  const setSession = useCallback(
    (value: string) => writeFilters({ [PARAM.session]: value }),
    [writeFilters],
  );

  const setRange = useCallback(
    (value: RangeValue) =>
      writeFilters({
        [PARAM.start]: value?.[0]?.toISOString() ?? "",
        [PARAM.end]: value?.[1]?.toISOString() ?? "",
      }),
    [writeFilters],
  );

  // Defaults are left out: an address bar full of page=1 is noise.
  const setPage = useCallback(
    (nextPage: number, nextSize = pageSize) =>
      write((next) => {
        if (nextPage > 1) next.set(PARAM.page, String(nextPage));
        else next.delete(PARAM.page);
        if (nextSize !== defaultPageSize) next.set(PARAM.size, String(nextSize));
        else next.delete(PARAM.size);
      }),
    [defaultPageSize, pageSize, write],
  );

  // Straight into the address rather than through the debounce: one click,
  // one reload.
  const reset = useCallback(() => {
    setTyped(EMPTY);
    written.current = EMPTY;
    writeFilters(
      Object.fromEntries(
        [
          PARAM.keyword,
          PARAM.model,
          PARAM.token,
          PARAM.username,
          PARAM.channel,
          PARAM.error,
          PARAM.start,
          PARAM.end,
          PARAM.session,
        ].map((name) => [name, ""]),
      ),
    );
  }, [writeFilters]);

  // Gates the 重置 link: nothing is dirty until one of the boxes is used.
  const dirty = Boolean(
    typed.keyword ||
      typed.model ||
      typed.token ||
      typed.username ||
      typed.channel ||
      onlyError ||
      range ||
      session,
  );

  return {
    keywordInput: typed.keyword,
    modelInput: typed.model,
    tokenInput: typed.token,
    usernameInput: typed.username,
    channelInput: typed.channel,
    ...typeInto,
    onlyError,
    setOnlyError,
    session,
    setSession,
    range,
    setRange,
    keyword,
    model,
    tokenName,
    username,
    channelID,
    page,
    pageSize,
    setPage,
    dirty,
    reset,
  };
}
