# Installing RetroWatchdog

This guide takes you from a computer with nothing on it to your first game in
RetroWatchdog. It assumes no experience with servers or Docker. Expect about
fifteen minutes, most of it waiting for downloads.

Before you start, read [LEGAL.md](../LEGAL.md): the app comes with no
warranty, its numbers are not financial advice, and each price source has
terms you, not the project, are responsible for. The installer leaves the
sources with legal conditions off unless you say yes.

## 1. Pick the computer it will live on

RetroWatchdog runs all the time in the background, so it works best on a
computer that stays on: a mini PC, an old laptop, a home server, a Raspberry
Pi 4 or 5, or a small cloud server. You then open it from any phone or
computer on the same network.

What it needs:

- **Linux** (Ubuntu, Debian, Raspberry Pi OS…) or **Windows** have a
  one-command installer ([Windows](#windows)). macOS works too, through
  Docker Desktop ([by hand](#macos-or-by-hand)).
- 2 GB of memory and 5 GB of free disk space.
- An internet connection.

You will need to type a few commands. On Linux, open the **Terminal**
application; on a server you reach over the network, connect to it with SSH.

## 2. Run the installer

Copy this line into the terminal and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/uniplexed/retrowatchdog/main/scripts/install.sh | bash
```

The installer:

1. installs Docker if it is missing (it asks first, and may ask for your
   password);
2. creates a `retrowatchdog` folder in your home folder;
3. asks you a few questions, explained below;
4. downloads RetroWatchdog and starts it.

Any question you are unsure about can be skipped with Enter and changed later
in the `.env` file in that folder.

### The questions

**Name or IP address other devices will use.** The address you will type in
the browser on your phone. The installer suggests this computer's address on
your network (something like `192.168.1.20`); accept it unless you have a
domain name for it.

**Price sources.** Which plugins to run. eBay is on unless you say no; CeX,
Vinted and Wallapop are off unless you say yes, because each has legal notes
to read first ("About the sources, and the law" in the README; the installer
prints the link).

- **CeX** needs CeX's public search key, and its catalogue is CeX's property:
  see "About the sources, and the law" in the README before you say yes. The
  [CeX plugin's README](https://github.com/uniplexed/retrowatchdog-cex-plugin#getting-the-algolia-key)
  explains where to find it in two minutes. Without it, skip the key now and
  add it later.
- **eBay** is official, under eBay's API License Agreement that you accept
  with your keys; the [eBay plugin's README](https://github.com/uniplexed/retrowatchdog-ebay-plugin#terms-of-use-ebays-api-license-agreement-binds-you)
  lists the clauses that touch this app. It needs your own free developer keys from
  [developer.eBay.com](https://developer.ebay.com). The
  [eBay plugin's README](https://github.com/uniplexed/retrowatchdog-ebay-plugin)
  walks through it.
- **Vinted** needs no key, but Vinted's
  [terms](https://www.vinted.co.uk/terms_and_conditions) forbid scraping without its authorization;
  get it first. It reads the UK, France, Germany, Spain and
  Ireland sites; switch on the countries you want in Settings → Markets.
- **Wallapop** needs no key, but Wallapop's
  [terms of use](https://about.wallapop.com/condiciones-de-uso/) require its express
  authorization to use it this way; get it first. It reads Spain, Italy and Portugal, ranking
  listings by distance from each country's capital; to search from your
  city, see [Wallapop: your city](#wallapop-your-city) below.

**Game catalogue (IGDB).** Free keys from [dev.twitch.tv](https://dev.twitch.tv)
that let search find any game. IGDB is free for non-commercial use; a
commercial deployment needs IGDB's partnership. Without them, search only finds games you
import, so it is worth the few minutes.

**Password.** Choose one. Anyone who can reach the app can change your
collection, so a password is a good idea even at home. The user name is
`retro`.

When it finishes, the installer prints the address to open.

## 3. Open it and trust the certificate

On your phone or computer, open the address the installer printed, for
example `https://192.168.1.20`.

The first time, the browser warns that the connection is not private. That is
expected: RetroWatchdog made its own certificate. To remove the warning for
good and to install the app on your phone's home screen:

1. Open `https://<the address>/root.crt` and download the certificate.
2. Install it:
   - **Android:** Settings → Security → Encryption & credentials → Install a
     certificate → CA certificate.
   - **iPhone/iPad:** open the downloaded profile in Settings, install it, then
     Settings → General → About → Certificate Trust Settings → switch it on.
   - **Windows:** double-click the file → Install Certificate → Local Machine →
     "Trusted Root Certification Authorities".
   - **macOS:** double-click the file, then in Keychain Access open it and set
     "Always Trust".
3. Reload the page. On a phone, use the browser's "Add to Home screen".

Until then you can click through the warning ("Advanced" → "Proceed").

## 4. First steps in the app

1. **Settings → Plugins.** Each plugin you started appears as pending. Open
   it, read what it asks for, tick the price kinds you accept, and approve it.
   Every ⓘ in the app explains what a section does, with an example.
2. **Settings → Markets.** Switch on the markets you buy from.
3. **Settings → Currencies.** Choose the currency you want to see prices in,
   and add any you use that are not listed.
4. **Search** a game you own, open it and press **I own this**. Search one you
   want and press **Watch**; choose the region and condition you are after
   first, so the watch looks only for that.

CeX's first catalogue sweep takes a few hours; after that prices refresh on
their own every few hours.

## Plugins and their keys

RetroWatchdog stores and compares prices; it does not fetch any by itself.
Every price comes from a plugin, so with no plugin running and approved the
app has your collection and your watchlist but no prices, no barks (signals),
no recommendations and no collection value. Each plugin is a small container
of its own, started by a profile in `COMPOSE_PROFILES` in `.env`, and it only
starts contributing once you approve it in Settings → Plugins and switch its
markets on in Settings → Markets.

| what | gives you | key | file |
| --- | --- | --- | --- |
| CeX plugin | what CeX sells for and pays (cash and voucher) in the UK, Spain and Ireland: the flip and trade-in barks | CeX's public search key | `.env.cex` |
| eBay plugin | active listings and their median in five markets: the market price everything else is judged against | your eBay developer keys | `.env.ebay` |
| Vinted plugin | private sellers' asking prices in the UK, France, Germany, Spain and Ireland | none | — |
| Wallapop plugin | private sellers' asking prices in Spain, Italy and Portugal | none (your city, optional) | `.env.wallapop` |
| IGDB (in the app, not a plugin) | search across every game, with covers and alternative names | your Twitch developer keys | `.env` |

eBay is the most important one: without a market price there is no baseline,
so bargain and flip barks have nothing to compare against.

The files live in the `retrowatchdog` folder, beside `.env`. Each one is
plain text, one `NAME=value` per line, and is yours to keep private. The
installer creates them from your answers; to add or change a key later, edit
the file and run `docker compose up -d` in that folder.

### CeX: the public search key

CeX's website sends this pair to every visitor's browser so the page can
search its catalogue. It is an unofficial channel: keep the plugin's pace
slow and use it for yourself.

1. On a computer, open `https://uk.webuy.com` and search for anything.
2. Open the browser's developer tools (F12) on the **Network** tab and search
   again.
3. Click the request to `search.webuy.io/1/indexes/*/queries`. In its address
   or headers, find `x-algolia-application-id` and `x-algolia-api-key`.
4. Put them in `.env.cex`:

   ```
   CEX_ALGOLIA_APP_ID=the application id
   CEX_ALGOLIA_API_KEY=the api key
   ```

CeX changes the pair now and then. When CeX prices stop updating, repeat
these steps.

### eBay: your developer keys

Free, and about ten minutes the first time.

1. Create an account at [developer.ebay.com](https://developer.ebay.com) and
   sign in.
2. Open **Application Keysets** and create a keyset for **Production** (not
   Sandbox: Sandbox has no real listings).
3. eBay asks how you handle its account-deletion notifications before it
   activates a Production keyset. RetroWatchdog stores no eBay user data, so
   choose the **exemption** and say that you do not persist eBay user data.
4. Copy the keyset's **App ID (Client ID)** and **Cert ID (Client Secret)**
   into `.env.ebay`:

   ```
   EBAY_CLIENT_ID=the app id
   EBAY_CLIENT_SECRET=the cert id
   ```

### IGDB: your Twitch developer keys

IGDB is the game catalogue, run by Twitch. Free.

1. Sign in at [dev.twitch.tv/console](https://dev.twitch.tv/console) with a
   Twitch account (Twitch asks you to turn on two-factor authentication).
2. **Register Your Application**: any name, OAuth Redirect URL
   `http://localhost`, category **Application Integration**, client type
   **Confidential**.
3. Open the application with **Manage**, copy the **Client ID**, and press
   **New Secret** to get the secret.
4. Put them in `.env`:

   ```
   IGDB_CLIENT_ID=the client id
   IGDB_SECRET=the secret
   ```

### Wallapop: your city

Wallapop shows the listings nearest a point, the capital by default (Madrid,
Rome, Lisbon). To search from your city:

1. In Google Maps, right-click your town and click the coordinates at the top
   of the menu; they are copied, for example `41.3874, 2.1686`.
2. Put them in `.env.wallapop`, one line per country you use:

   ```
   WALLAPOP_LOCATION_ES=41.3874,2.1686
   ```

   (`WALLAPOP_LOCATION_IT` for Italy, `WALLAPOP_LOCATION_PT` for Portugal.)

### Check that a plugin works

1. Run `docker compose up -d` in the `retrowatchdog` folder.
2. In Settings → Plugins, press **Check now** on the plugin. It should say
   it is configured; approve it if it is still pending.
3. In Settings → Markets, switch on its markets.
4. Open a game: each market shows its prices. CeX's first catalogue sweep
   takes a few hours.

## Phone alerts (optional)

1. Install the [ntfy](https://ntfy.sh) app on your phone and subscribe to a
   topic with a long, random name only you know.
2. In the `retrowatchdog` folder, put that name in `.env`:
   `NTFY_TOPIC=your-long-random-name`.
3. Run `docker compose up -d` in that folder.

## Updating

Run the installer again. It keeps your settings and data and starts the new
version. By hand:

```bash
cd ~/retrowatchdog
docker compose pull
docker compose up -d
```

## Backing up

Everything you entered lives in a Docker volume called `retrowatchdog_pgdata`.
To save a copy:

```bash
cd ~/retrowatchdog
docker compose exec -T postgres pg_dump -U retrowatchdog retrowatchdog > backup.sql
```

Keep `backup.sql` and your `.env` somewhere safe.

## Windows

1. Open **PowerShell** (Start menu → type "PowerShell").
2. Paste this line and press Enter:

   ```powershell
   irm https://raw.githubusercontent.com/uniplexed/retrowatchdog/main/scripts/install.ps1 | iex
   ```

   If Docker Desktop is missing, the installer offers to install it. Windows
   may ask you to restart; afterwards start Docker Desktop from the Start
   menu, wait until it says it is running, and paste the line again.
3. Answer the same questions as in [step 2](#the-questions). When it
   finishes, the browser opens the app.

Ports 80 and 443 must be free: if another program uses them (IIS, another web
server), stop it first. Docker Desktop must be running whenever you want to
use RetroWatchdog; it can start with Windows (Docker Desktop → Settings →
General).

## macOS, or by hand

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
   and start it.
2. Create a folder for RetroWatchdog and download two files into it:
   [docker-compose.yml](https://raw.githubusercontent.com/uniplexed/retrowatchdog/v1.0.0/docker-compose.yml)
   and [.env.example](https://raw.githubusercontent.com/uniplexed/retrowatchdog/v1.0.0/.env.example).
   Rename `.env.example` to `.env` and open it in a text editor: every setting
   is explained there, and all are optional.
3. Open a terminal in that folder (PowerShell on Windows, Terminal on macOS)
   and run `docker compose pull`, then `docker compose up -d`.
4. Open `https://localhost`.

## If something goes wrong

- **The page does not load.** Check the computer is on and that you typed the
  address the installer printed. In the folder, `docker compose ps` lists the
  services; all should say "running" or "healthy".
- **"This host name is not one the app answers to".** You opened it by a name
  that is not in `PUBLIC_HOST`. Add it there (comma-separated) and run
  `docker compose up -d`.
- **A plugin shows an error.** Its keys are probably missing: they live in
  `.env.cex` or `.env.ebay` in the same folder. Add them and run
  `docker compose up -d`.
- **Logs.** `docker compose logs api --tail 50` shows the last messages.
