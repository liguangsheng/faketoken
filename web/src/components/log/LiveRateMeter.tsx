import { Space } from "antd";

import { useLiveRate, type LiveRateStore } from "../../hooks/useLiveRate";
import { formatCompact } from "../../utils/format";
import RateCard from "../RateCard";

interface Props {
  /** The samples; written by the feed, read by this component. */
  store: LiveRateStore;
  /** Whether the meters are sampling at all. */
  rateActive: boolean;
  /** Why the RPM/TPM meters are parked. */
  idleHint: string;
  /** The concurrency meter follows the feed, not the first page. */
  concurrencyActive: boolean;
  concurrencyIdleHint: string;
  /** The running set's size. */
  liveCalls: number;
  /** The push toggle, which belongs next to the meters it governs. */
  children?: React.ReactNode;
}

/** The RPM / TPM / concurrency pulse above the global board. */
export default function LiveRateMeter({
  store,
  rateActive,
  idleHint,
  concurrencyActive,
  concurrencyIdleHint,
  liveCalls,
  children,
}: Props) {
  // The one-second tick lives here, so the table above does not re-render
  // every second just to move two numbers.
  const rate = useLiveRate(store, rateActive);

  return (
    <Space size={8} style={{ marginBottom: 12 }}>
      <RateCard
        label="RPM"
        value={rate.rpm}
        active={rateActive}
        idleHint={idleHint}
      />
      <RateCard
        label="TPM"
        value={rate.tpm}
        format={formatCompact}
        active={rateActive}
        idleHint={idleHint}
      />
      {/* Not a sample of the page like the two beside it: the feed states
          the whole running set, so this stays right on page four, where a
          meter drawn from the visible rows cannot. Hence its own active
          condition — the feed being connected, not the first page. */}
      <RateCard
        label="并发"
        value={liveCalls}
        active={concurrencyActive}
        idleHint={concurrencyIdleHint}
        activeHint="此刻已转发给上游、尚未结束的调用数 · 跟随筛选条件"
      />
      {children}
    </Space>
  );
}
