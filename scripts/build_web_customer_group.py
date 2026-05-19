#!/usr/bin/env python3
"""Build web_customer_group.csv: merge by phone, weight = order count (desc)."""
from __future__ import annotations

import csv
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

from export_food4u_web_customers import dedupe_by_phone, fetch_all_orders, norm_phone

ROOT = Path(__file__).resolve().parents[1]
WEB_CUSTOMER_CSV = ROOT / "customers" / "web_customer.csv"
DEFAULT_OUT = ROOT / "customers" / "web_customer_group.csv"
GROUP_HEADERS = ["Phone", "Name", "email", "Address", "Eircode", "Order Source", "Weight"]


def load_web_customers(path: Path) -> dict[str, dict[str, str]]:
    by_phone: dict[str, dict[str, str]] = {}
    with path.open(encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            phone = norm_phone(row.get("Phone", ""))
            if phone:
                by_phone[phone] = row
    return by_phone


def build_group(
    web_customer_path: Path,
    out_path: Path,
    cookie: str | None = None,
    delay_sec: float = 0.8,
) -> int:
    base = load_web_customers(web_customer_path)
    print(f"Loaded {len(base)} rows from {web_customer_path}", flush=True)

    if not cookie:
        raise RuntimeError("FOOD4U_COOKIE is required to count orders per phone from WebOrderInfo.")

    orders = fetch_all_orders(cookie, delay_sec)
    print(f"Fetched {len(orders)} orders", flush=True)

    weights: Counter[str] = Counter()
    sources: dict[str, set[str]] = defaultdict(set)
    extras: dict[str, list[dict[str, str]]] = defaultdict(list)

    for order in orders:
        phone = norm_phone(order.get("Phone", ""))
        if not phone:
            continue
        weights[phone] += 1
        src = (order.get("Order Source") or "").strip()
        if src:
            sources[phone].add(src)
        if phone not in base:
            extras[phone].append(order)

    grouped: list[dict[str, str]] = []
    for phone, weight in weights.most_common():
        if phone in base:
            row = dict(base[phone])
        else:
            merged = dedupe_by_phone(extras[phone])
            row = merged[0] if merged else {"Phone": phone, "Name": "", "email": "", "Address": "", "Eircode": "", "Order Source": ""}

        src_parts = sorted(sources.get(phone, set()))
        if src_parts:
            row["Order Source"] = "; ".join(src_parts)
        row["Weight"] = str(weight)
        grouped.append({h: row.get(h, "") for h in GROUP_HEADERS})

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=GROUP_HEADERS)
        w.writeheader()
        w.writerows(grouped)

    return len(grouped)


def main() -> None:
    cookie = os.environ.get("FOOD4U_COOKIE", "").strip()
    src = Path(os.environ.get("FOOD4U_WEB_SRC", str(WEB_CUSTOMER_CSV)))
    out = Path(os.environ.get("FOOD4U_GROUP_OUT", str(DEFAULT_OUT)))

    if not src.is_file():
        print(f"Missing source file: {src}", file=sys.stderr)
        sys.exit(1)

    try:
        count = build_group(src, out, cookie=cookie or None)
    except Exception as e:
        print(f"Build failed: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"Wrote {count} rows to {out}")


if __name__ == "__main__":
    main()
