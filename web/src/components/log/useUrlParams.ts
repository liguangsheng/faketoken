import { useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Reading and writing the query string.
 *
 * React Router's own `setSearchParams` always navigates to `"?" + params`, so
 * an empty set of parameters becomes a bare `?` — and a write that changes
 * nothing still pushes a history entry. This writes the address directly
 * instead: the same path, a new search, and no navigation at all when the
 * result is what the address already says.
 *
 * A write starts from the address bar, not from the rendered location: two
 * writes in one tick would otherwise both start from the same old search, and
 * the second would undo the first. It also keeps `write` stable, so an effect
 * that writes does not run again just because the address moved.
 */
export function useUrlParams() {
  const location = useLocation();
  const navigate = useNavigate();

  const params = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );

  const write = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(window.location.search);
      const before = next.toString();
      mutate(next);
      const search = next.toString();
      if (search === before) return;
      navigate(
        {
          pathname: window.location.pathname,
          search: search ? `?${search}` : "",
        },
        { replace: true },
      );
    },
    [navigate],
  );

  return { params, write };
}
