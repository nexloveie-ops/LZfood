#!/usr/bin/env python3
"""Export Food4U web order customers from WebOrderInfo.aspx."""
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

URL = "https://www.food4u.ie/backoffice/Epos_Shop/WebOrderInfo.aspx"
NEXT_TARGET = "ctl00$ContentPlaceHolder1$lbnNextPage"
GRID_ID = "ctl00_ContentPlaceHolder1_gvWebOrder"
HEADERS = ["Phone", "Name", "email", "Address", "Eircode", "Order Source"]
EIRCODE_RE = re.compile(
    r"\b([AC-FHKNPRTV-Y][0-9]{2})\s*([0-9AC-FHKNPRTV-Y]{4})\b",
    re.IGNORECASE,
)
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "customers" / "web_customer.csv"


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


def split_eircode(address: str) -> tuple[str, str]:
    if not address.strip():
        return "", ""
    matches = list(EIRCODE_RE.finditer(address))
    if not matches:
        return "", address.strip()
    m = matches[-1]
    eircode = f"{m.group(1).upper()} {m.group(2).upper()}"
    cleaned = (address[: m.start()] + address[m.end() :]).strip()
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,")
    return eircode, cleaned


def norm_phone(phone: str) -> str:
    return re.sub(r"\s+", "", (phone or "").strip())


def parse_rows(html: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id=GRID_ID)
    if not table:
        return []

    trs = table.find_all("tr")
    if not trs:
        return []

    headers = [th.get_text(strip=True) for th in trs[0].find_all("th")]
    col = {name: i for i, name in enumerate(headers)}

    def cell_text(tds: list, name: str) -> str:
        idx = col.get(name)
        if idx is None or idx >= len(tds):
            return ""
        return tds[idx].get_text(strip=True)

    rows: list[dict[str, str]] = []
    for tr in trs[1:]:
        tds = tr.find_all("td", recursive=False)
        if len(tds) < len(headers):
            continue
        raw_address = cell_text(tds, "Address")
        eircode, address = split_eircode(raw_address)
        rows.append(
            {
                "Phone": cell_text(tds, "Phone"),
                "Name": cell_text(tds, "Name"),
                "email": cell_text(tds, "Email"),
                "Address": address,
                "Eircode": eircode,
                "Order Source": cell_text(tds, "Order Source"),
            }
        )
    return rows


def dedupe_by_phone(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    def score(row: dict[str, str]) -> tuple:
        addr = (row.get("Address") or "").strip()
        return (
            1 if addr else 0,
            1 if (row.get("Eircode") or "").strip() else 0,
            1 if (row.get("Name") or "").strip() else 0,
            1 if (row.get("email") or "").strip() else 0,
            len(addr),
            sum(1 for v in row.values() if (v or "").strip()),
        )

    no_phone: list[dict[str, str]] = []
    best: dict[str, dict[str, str]] = {}
    order: list[str] = []

    for row in rows:
        phone = norm_phone(row.get("Phone", ""))
        if not phone:
            no_phone.append(row)
            continue
        if phone not in best:
            best[phone] = row
            order.append(phone)
        elif score(row) > score(best[phone]):
            best[phone] = row

    return no_phone + [best[p] for p in order]


def fetch_all_orders(cookie: str, delay_sec: float = 0.8) -> list[dict[str, str]]:
    html = fetch("GET", cookie)
    if "Login Management System" in html:
        raise RuntimeError("Cookie expired or invalid — log in again and refresh FOOD4U_COOKIE.")

    tp = total_pages(html) or 1
    all_rows: list[dict[str, str]] = []
    page = current_page(html) or 1
    all_rows.extend(parse_rows(html))
    print(f"Page {page}/{tp}: +{len(parse_rows(html))}, total {len(all_rows)}", flush=True)

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

    return all_rows


def export(cookie: str, out_path: Path, delay_sec: float = 0.8) -> int:
    all_rows = fetch_all_orders(cookie, delay_sec)
    deduped = dedupe_by_phone(all_rows)
    print(f"Orders scraped: {len(all_rows)}; unique phones: {len(deduped)}", flush=True)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=HEADERS)
        w.writeheader()
        w.writerows(deduped)
    return len(deduped)


def main() -> None:
    cookie = os.environ.get("FOOD4U_COOKIE", "").strip()
    if not cookie:
        print("Set FOOD4U_COOKIE to your browser Cookie header value.", file=sys.stderr)
        sys.exit(1)
    out = Path(os.environ.get("FOOD4U_WEB_OUT", str(DEFAULT_OUT)))
    try:
        count = export(cookie, out)
    except Exception as e:
        print(f"Export failed: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"Wrote {count} rows to {out}")


if __name__ == "__main__":
    main()
