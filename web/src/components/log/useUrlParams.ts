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
      const next = new URLSearchParams(location.search);
      mutate(next);
      const search = next.toString();
      if (search === location.search.replace(/^\?/, "")) return;
      navigate(
        {
          pathname: location.pathname,
          search: search ? `?${search}` : "",
        },
        { replace: true },
      );
    },
    [location.pathname, location.search, navigate],
  );

  return { params, write };
}
