import { useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  DatePicker,
  Drawer,
  Input,
  Select,
  Space,
  Typography,
} from "antd";
import {
  FilterOutlined,
  KeyOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  UserOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

import type { RangeValue, useLogFilters } from "./useLogFilters";

interface Props {
  admin?: boolean;
  filters: ReturnType<typeof useLogFilters>;
  loading: boolean;
  onReload: () => void;
  /**
   * Where the push toggle goes. It is drawn by the caller because the admin
   * board also needs it next to the meters.
   */
  liveToggle?: ReactNode;
  /** Arrivals parked while the reader is on another page. */
  pending: number;
  /** Arrivals parked while the pointer is over the table. */
  hoverPending: number;
  onBackToFirstPage: () => void;
  /** Phones fold everything but the keyword box behind a 筛选 button. */
  narrow?: boolean;
  extra?: ReactNode;
}

/** The filter row above the table. */
export default function LogFilterBar({
  admin,
  filters,
  loading,
  onReload,
  liveToggle,
  pending,
  hoverPending,
  onBackToFirstPage,
  narrow,
  extra,
}: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const {
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
    dirty,
    reset,
  } = filters;

  // The range is computed when the preset is picked, not when the bar is
  // drawn: a page left open for an hour must not hand out a range that ended
  // an hour ago.
  const presets = [
    {
      label: "最近 1 小时",
      value: () => [dayjs().subtract(1, "hour"), dayjs()] as [Dayjs, Dayjs],
    },
    {
      label: "今天",
      value: () => [dayjs().startOf("day"), dayjs()] as [Dayjs, Dayjs],
    },
    {
      label: "最近 7 天",
      value: () => [dayjs().subtract(7, "day"), dayjs()] as [Dayjs, Dayjs],
    },
    {
      label: "最近 30 天",
      value: () => [dayjs().subtract(30, "day"), dayjs()] as [Dayjs, Dayjs],
    },
  ];

  // Everything but the keyword box: on a phone these are what turned the bar
  // into five rows and pushed the first card below the fold.
  const narrowed = Boolean(
    modelInput || tokenInput || usernameInput || channelInput || onlyError || range,
  )

  const rest = (
    <>
      {/* Prefix icons keep the filters tellable-apart once they hold text
          and the placeholder is gone. */}
      <Input
        allowClear
        prefix={<RobotOutlined className="text-muted" />}
        placeholder="模型"
        aria-label="按模型过滤"
        style={{ width: 160 }}
        value={modelInput}
        onChange={(event) => setModelInput(event.target.value)}
      />
      <Input
        allowClear
        prefix={<KeyOutlined className="text-muted" />}
        placeholder="密钥"
        aria-label="按密钥名过滤"
        style={{ width: 140 }}
        value={tokenInput}
        onChange={(event) => setTokenInput(event.target.value)}
      />
      {admin && (
        <Input
          allowClear
          prefix={<UserOutlined className="text-muted" />}
          placeholder="用户名"
          aria-label="按用户名过滤"
          style={{ width: 150 }}
          value={usernameInput}
          onChange={(event) => setUsernameInput(event.target.value)}
        />
      )}
      <Input
        allowClear
        prefix={<span className="text-muted">#</span>}
        placeholder="渠道 ID"
        aria-label="按渠道 ID 过滤，仅支持数字"
        style={{ width: 110 }}
        value={channelInput}
        onChange={(event) => setChannelInput(event.target.value.replace(/\D/g, ""))}
      />
      <Select
        value={onlyError}
        style={{ width: 110 }}
        aria-label="按结果过滤"
        onChange={setOnlyError}
        options={[
          { value: false, label: "全部请求" },
          { value: true, label: "仅失败" },
        ]}
      />
      <DatePicker.RangePicker
        showTime={{ format: "HH:mm" }}
        format="MM-DD HH:mm"
        value={range}
        presets={presets}
        onChange={(value) => setRange(value as RangeValue)}
        style={{ width: 300 }}
      />
      {dirty && (
        <Button type="link" onClick={reset}>
          重置
        </Button>
      )}
    </>
  )

  const keywordBox = (
    <Input
      allowClear
      prefix={<SearchOutlined className="text-muted" />}
      placeholder={
        admin
          ? "搜索 ID、用户、密钥、模型、渠道、IP、错误"
          : "搜索 ID、密钥、模型、接口、错误"
      }
      aria-label="搜索日志"
      style={{ width: 300 }}
      value={keywordInput}
      onChange={(event) => setKeywordInput(event.target.value)}
    />
  )

  // The count is what makes folding these away safe: a filter left on in a
  // closed sheet would otherwise narrow the list invisibly.
  const activeCount = [
    modelInput,
    tokenInput,
    usernameInput,
    channelInput,
    onlyError,
    range,
  ].filter(Boolean).length

  if (narrow) {
    return (
      <Space
        direction="vertical"
        size={8}
        style={{ marginBottom: 12, width: "100%" }}
      >
        <Space.Compact style={{ width: "100%" }}>
          {keywordBox}
          <Button
            icon={<FilterOutlined />}
            aria-label={`筛选${activeCount ? `，已选 ${activeCount} 项` : ""}`}
            onClick={() => setSheetOpen(true)}
          >
            筛选{activeCount ? ` (${activeCount})` : ''}
          </Button>
        </Space.Compact>
        <Space wrap size={8}>
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={onReload}
          >
            刷新
          </Button>
          {liveToggle}
          {pending > 0 && (
            <Button type="link" size="small" onClick={onBackToFirstPage}>
              有 {pending} 条新记录
            </Button>
          )}
        </Space>
        {/* A bottom sheet, not a full page: the list stays visible behind it,
            so a filter change can be watched landing. */}
        <Drawer
          placement="bottom"
          height="auto"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title={
            <Space size={8}>
              <span>筛选</span>
              {narrowed && (
                <Button type="link" size="small" onClick={reset}>
                  重置
                </Button>
              )}
            </Space>
          }
        >
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            {rest}
          </Space>
        </Drawer>
      </Space>
    );
  }

  return (
    <Space wrap className="filter-bar" style={{ marginBottom: 12 }} size={8}>
      {keywordBox}
      {rest}
      <Button icon={<ReloadOutlined />} loading={loading} onClick={onReload}>
        刷新
      </Button>
      {liveToggle}
      {pending > 0 && (
        <Button type="link" size="small" onClick={onBackToFirstPage}>
          有 {pending} 条新记录
        </Button>
      )}
      {hoverPending > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hoverPending} 条新记录待插入（悬停时暂停）
        </Typography.Text>
      )}
      {extra}
    </Space>
  );
}
