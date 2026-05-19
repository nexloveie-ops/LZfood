#!/usr/bin/env python3
"""Export Food4U EPOS customers to CSV (requires FOOD4U_COOKIE env var)."""
from __future__ import annotations

import csv
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

from bs4 import BeautifulSoup

URL = "https://www.food4u.ie/backoffice/Epos_Shop/CustomerManage.aspx"
NEXT_TARGET = "ctl00$ContentPlaceHolder1$lbnNextPage"
HEADERS = [
    "CustomerId",
    "Name",
    "Phone",
    "Address",
    "Expenditure",
    "OrderQty",
    "AccountCreatedTime",
    "LastOrderTime",
    "SpecialRequest",
    "DateOfBirth",
    "Email",
    "Deposit",
    "Credit",
    "Discount",
    "IsBlocked",
    "Bonus",
]
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "customers" / "customers.csv"


class FormParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.fields: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "input":
            return
        d = {k: v for k, v in attrs if k is not None}
        typ = (d.get("type") or "text").lower()
        name = d.get("name")
        if not name or typ in ("checkbox", "radio", "submit", "button", "image", "file"):
            return
        self.fields[name] = d.get("value") or ""


def ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    try:
        import certifi  # type: ignore

        ctx.load_verify_locations(certifi.where())
    except Exception:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def fetch(method: str, cookie: str, data: bytes | None = None) -> str:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
        ),
        "Cookie": cookie,
        "Referer": URL,
        "Origin": "https://www.food4u.ie",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(URL, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, context=ssl_context(), timeout=180) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_form(html: str) -> dict[str, str]:
    p = FormParser()
    p.feed(html)
    return p.fields


def current_page(html: str) -> int | None:
    m = re.search(r"lblCurrentPage[^>]*>(\d+)", html)
    return int(m.group(1)) if m else None


def total_pages(html: str) -> int | None:
    m = re.search(r"lblPageCount[^>]*>(\d+)", html)
    return int(m.group(1)) if m else None


def parse_rows(html: str) -> list[list[str]]:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="ctl00_ContentPlaceHolder1_gvCustomer")
    if not table:
        return []

    data_cols = len(HEADERS) - 1  # excluding CustomerId
    rows: list[list[str]] = []
    for tr in table.find_all("tr"):
        if not tr.find("input", id=re.compile(r"gvCustomer_ctl\d+_cbCustomer")):
            continue
        tds = tr.find_all("td", recursive=False)
        if len(tds) < 2 + data_cols:
            continue

        edit = tr.find("a", href=re.compile(r"CustomerEdit\.aspx\?ID=", re.I))
        cid = ""
        if edit:
            m = re.search(r"ID=(-?\d+)", edit.get("href", ""), re.I)
            cid = m.group(1) if m else ""

        data = [cid] + [tds[i].get_text(strip=True) for i in range(2, 2 + data_cols)]
        rows.append(data)
    return rows


def export(cookie: str, out_path: Path, delay_sec: float = 0.8) -> int:
    html = fetch("GET", cookie)
    if "Login Management System" in html:
        raise RuntimeError("Cookie expired or invalid — log in again and refresh FOOD4U_COOKIE.")

    tp = total_pages(html) or 1
    all_rows: list[list[str]] = []
    page = current_page(html) or 1
    all_rows.extend(parse_rows(html))
    print(f"Page {page}/{tp}: +{len(all_rows)} total", flush=True)

    while page < tp:
        fields = parse_form(html)
        fields["__EVENTTARGET"] = NEXT_TARGET
        fields["__EVENTARGUMENT"] = ""
        body = urllib.parse.urlencode(fields).encode()
        time.sleep(delay_sec)
        html = fetch("POST", cookie, body)
        if "Login Management System" in html:
            raise RuntimeError(f"Session lost at page {page + 1}.")
        page = current_page(html) or (page + 1)
        chunk = parse_rows(html)
        all_rows.extend(chunk)
        print(f"Page {page}/{tp}: +{len(chunk)}, total {len(all_rows)}", flush=True)

    deduped = _dedupe_rows(all_rows)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(HEADERS)
        w.writerows(deduped)
    return len(deduped)


def _dedupe_rows(rows: list[list[str]]) -> list[list[str]]:
    """Food4U list pages may repeat the same CustomerId; keep the fullest row."""
    cid_idx = HEADERS.index("CustomerId")

    def score(row: list[str]) -> int:
        return sum(1 for v in row if v.strip())

    best: dict[str, list[str]] = {}
    order: list[str] = []
    for row in rows:
        cid = row[cid_idx]
        if cid not in best:
            best[cid] = row
            order.append(cid)
        elif score(row) > score(best[cid]):
            best[cid] = row
    return [best[cid] for cid in order]


def main() -> None:
    cookie = os.environ.get("FOOD4U_COOKIE", "").strip()
    if not cookie:
        print("Set FOOD4U_COOKIE to your browser Cookie header value.", file=sys.stderr)
        sys.exit(1)
    out = Path(os.environ.get("FOOD4U_OUT", str(DEFAULT_OUT)))
    try:
        count = export(cookie, out)
    except Exception as e:
        print(f"Export failed: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"Wrote {count} rows to {out}")


if __name__ == "__main__":
    main()
