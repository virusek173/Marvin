# Plan: archiwum wiadomości jako jedyne źródło historii i kontekstu Marvina

Status: plan, nic jeszcze nie zaimplementowane. Branch: `feat/message-history-search`.
Wersja po drugiej turze ustaleń (usunięcie codziennego 6:00, opisy obrazów, jedna zmienna wykluczeń,
kontekst Marvina z bazy zamiast z `context.json`).

## Cel

1. Dać Marvinowi możliwość odpowiadania na pytania o historię czatu ("kto pisał o X", "co było wczoraj po 18:00").
2. Baza SQLite staje się jedynym miejscem, gdzie żyje historia czatu: z niej czytają zarówno wyszukiwanie historii,
   jak i bieżący kontekst rozmowy Marvina (zamiast pamięci procesu zapisywanej do `data/context.json`).

Zamiast generycznego MCP Discorda: lokalne archiwum wiadomości w SQLite z indeksem pełnotekstowym (FTS5)
oraz kilka własnych funkcji tylko do odczytu, wystawionych głównemu modelowi (tool calling).

## Dlaczego nie MCP Discorda

- Marvin ma już zalogowanego klienta discord.js z uprawnieniami; MCP to drugi proces z tym samym tokenem.
- Zdalny MCP w Responses API OpenAI wymaga publicznego endpointu HTTPS, czyli wystawienia historii czatu na zewnątrz.
- Gotowe serwery MCP mają zwykle narzędzia zapisu/moderacji (send, delete, ban). Chcemy tylko odczyt.
- API Discorda nie daje botom wyszukiwania pełnotekstowego; trzeba by skanować kanały (wolno, rate limity, tokeny).

## Co daje SQLite + FTS5

- Trwała historia (bez limitu 30 wiadomości FIFO), przetrwa restarty (wolumin `marvin_data`).
- Szybkie szukanie po słowach: frazy, OR/NOT, prefiksy (`rower*`), NEAR, ranking `bm25`.
- Filtry SQL razem z tekstem: autor, kanał, zakres dat; zliczanie; kontekst wokół wiadomości.
- Ograniczenie: brak rozumienia znaczenia/fleksji (tokenizer `unicode61` + `remove_diacritics`, prefiksy częściowo pomagają).
  Wyszukiwanie semantyczne wymagałoby embeddingów — poza zakresem.
- Biblioteka: `better-sqlite3` (natywna, sprawdzić build na `node:22.0.0-alpine`) albo wbudowany `node:sqlite`
  (w Node 22.0.0 eksperymentalny, FTS5 nie zawsze włączone). Do rozstrzygnięcia eksperymentem na początku.

## Ustalenia

- Archiwizujemy wszystkie wiadomości, także od botów i odpowiedzi Marvina.
- Backfill: zaciągnięcie wszystkich wiadomości od początku historii.
- Przy każdym uruchomieniu: sprawdzenie, czy na jakimś kanale są wiadomości nowsze niż w bazie, i dogranie ich.
- Dostęp wyłącznie do odczytu (nic nie może być usunięte/zmienione na serwerze).
- Edycje i usunięcia wiadomości: na razie świadomie pomijamy (znane ograniczenie: usunięta wiadomość zostaje
  w archiwum, edytowana ma starą treść).
- Dużo logowania (`console.warn` / `console.error`), żeby szybko dojść do przyczyny awarii.
- Bez limitu retencji na start.
- **Usuwamy codzienne niszczenie i odtwarzanie klienta o 6:00** (nieużywane). Klient Discorda i `DiscordServce` powstają
  raz przy starcie procesu, więc baza, blokada synchronizacji i timery mogą żyć w instancji.
- **Obrazy:** wiadomości przychodzące na żywo mają obraz zamieniony na tekstowy opis (jak dziś w
  `userResponseFactory`) i ten opis jest zapisywany w bazie razem z treścią. Backfill NIE opisuje obrazów (koszt):
  zapisuje tylko znacznik z typem/nazwą załącznika. Adresy CDN wygasają, więc ich nie traktujemy jako trwałych.
- **Jedna zmienna wykluczeń kanałów** zamiast dwóch (patrz niżej).
- **Marvin zapisuje się do bazy tak samo jak każdy inny autor**, a jego kontekst rozmowy jest czytany z bazy.
  `data/context.json` przestaje być potrzebny.

## Ustalenia z kodu, które wpływają na plan

- `index.ts` dotąd co dzień o 6:00 niszczył klienta i tworzył nowego. Po usunięciu tego crona znika też
  skutek uboczny: data w system prompcie Marvina jest liczona w konstruktorze `DiscordServce`, więc bez codziennego
  odtwarzania zestarzałaby się. Prompt systemowy trzeba budować per żądanie (albo odświeżać datę).
- Handler `messageCreate` zaczyna od pominięcia wiadomości Marvina (`return` po nazwie użytkownika). Zapis do
  archiwum musi stanąć przed tym `return`, żeby odpowiedzi Marvina też trafiały do bazy (wracają do bota jako
  zwykłe zdarzenia).
- Dziś do kontekstu trafia tylko finalna odpowiedź Marvina. Wysyłane na kanał komunikaty techniczne
  ("Zaglądam do Internetu", leniwe odpowiedzi na obrazy, komunikat "Wywaliłem się...") nie są w kontekście.
  Po przejściu na bazę wszystkie wiadomości Marvina trafią do archiwum, więc te techniczne trzeba oznaczyć i
  wykluczać z kontekstu dla modelu (patrz Etap 3).
- Kod bota wysyła na serwer wyłącznie `reply`, `send` i `sendTyping`; nic usuwającego ani moderującego.
- Intents: `Guilds`, `GuildMessages`, `MessageContent` — wystarczają do zapisu live i backfillu.
- `Message` w `openai.ts` zna tylko role system/user/assistant; tool calling wymaga rozszerzenia typu.
- Nazwy w Discordzie ≠ imiona z ekipy (Hardik/Dombear = Domin). Pytania będą po imieniu, więc wyszukiwanie
  musi tłumaczyć imię na identyfikatory autorów.

## Etapy

### Etap 0: sprzątanie (usunięcie crona 6:00)

- `index.ts`: usunąć cron 6:00 i odtwarzanie klienta; klient tworzony raz przy starcie. Usunąć zmienną `WITH_CRON`
  i jej wzmianki. Cron podsumowania 20:00 zostaje bez zmian.
- `discord.ts`: prompt systemowy z aktualną datą budowany per żądanie (żeby data nie zastarzała).
- Martwy kod porannego cytatu (generowanie cytatu przy starcie, `quotesArray`, `getFirstMotivionUserMessagePrompt`,
  gałąź "z wiadomością powitalną" w handlerze `ready`) — do usunięcia (decyzja podjęta).
  Wiadomość "wstałem" po restarcie zostaje.
- Dokumentacja (`CLAUDE.md`, `ARCHITECTURE.md`) poprawiona o brak crona 6:00.

### Etap 1: baza, schemat i zapis na żywo

- Zależność SQLite w `package.json`; najpierw eksperyment na obrazie alpine. Jeśli brak gotowych binarek,
  `Dockerfile` dostaje narzędzia do kompilacji.
- Nowy moduł bazy: plik w `data/` (staging ma osobny wolumin, więc osobną bazę), tryb WAL, schemat tworzony
  automatycznie:
  - tabela wiadomości z kluczem głównym = id wiadomości Discorda;
  - tabela stanu synchronizacji (jeden wiersz na kanał/wątek: kursor, czas ostatniej próby, ostatni błąd);
  - indeks pełnotekstowy FTS5 utrzymywany automatycznie przy wstawianiu.
- Pola wiadomości: id, kanał, wątek nadrzędny, autor (id + surowa nazwa z Discorda), flaga bota, treść,
  spłaszczony tekst embedów, opis/znacznik załączników, id wiadomości-rodzica (odpowiedź), typ wiadomości
  (zwykła/systemowa), flaga "techniczna" (komunikat Marvina niewchodzący do kontekstu), czas w UTC.
- Imię z ekipy mapowane dopiero przy odczycie (zmiana mapowania w `helpers.ts` działa wstecz).
- Podpięcie w `discord.ts`: w `messageCreate`, przed pominięciem własnych wiadomości, zapis do archiwum
  (po zbudowaniu opisu obrazu dla wiadomości z obrazami). Otoczone try/catch — tylko logowanie, awaria bazy nie
  blokuje odpowiedzi.
- Wyłączenie wykluczonych kanałów z zapisu (patrz Konfiguracja).

### Etap 2: backfill i dogrywanie

- Nowy moduł synchronizacji, wołany po zdarzeniu `ready` i cyklicznie (np. co godzinę). Blokada przed
  równoległymi przebiegami.
- Lista kanałów: tekstowe, ogłoszeniowe, głosowe z czatem, aktywne wątki, archiwalne wątki, posty na forach.
  Nowe kanały/wątki automatycznie trafiają na pełny import (brak kursora). Archiwalne wątki prywatne wymagają
  Manage Threads, którego bot celowo nie ma — pomijane z ostrzeżeniem (świadomy kompromis read-only vs kompletność).
- Pętla dla kanału: strona 100 wiadomości nowszych niż kursor, sortowanie rosnąco (Discord zwraca malejąco),
  zapis strony i przesunięcie kursora w jednej transakcji, powtarzanie do pustej strony. Pierwszy import
  startuje od najstarszej wiadomości kanału. Przerwanie w środku nic nie psuje.
- Strony małe i z oddawaniem sterowania, bo zapis jest synchroniczny i nie może blokować połączenia z Discordem.
- Kursor przesuwa się WYŁĄCZNIE po zatwierdzonej paczce z dogrywania; zapis live go nie rusza (inaczej luka po
  przerwie w działaniu zostałaby pominięta na stałe).
- Wstawianie z `INSERT OR IGNORE` po id: duplikaty z zapisu live są pomijane i nic nie jest nadpisywane
  (bogatszy wiersz live, np. z opisem obrazu, wygrywa z backfillem).
- Dogrywanie na żądanie: przy pierwszym użyciu kanału po starcie (np. gdy ktoś woła Marvina) kanał jest
  najpierw szybko dociągany; jeśli kanał nie ma jeszcze żadnych danych, pobieramy najnowsze wiadomości bez
  ruszania kursora, żeby kontekst nie był pusty zanim backfill do niego dojdzie.
- Błąd w jednym kanale zapisuje się w jego wierszu stanu i nie przerywa reszty. Błędy przejściowe (rate limit,
  5xx, zerwane połączenie): ponowienia z rosnącym odstępem; trwałe (403, 404): bez ponowień.
- Pobieranie z Discorda ukryte za małym interfejsem, żeby w testach podstawić sztuczne strony.
- Znacznik "techniczna" dla komunikatów Marvina ustawiany tym samym mechanizmem w live i w backfillu:
  dopasowanie do znanej listy stałych fraz (leniwe odpowiedzi, komunikaty o Internecie/linkach, prefiks
  "Wywaliłem się...").

### Etap 3: kontekst Marvina z bazy (koniec z `context.json`)

- `ContextService` zastąpiony warstwą czytającą z bazy: kontekst kanału = ostatnie N wiadomości (domyślnie 30)
  tego kanału, bez oznaczonych jako techniczne, zamienione na format OpenAI: wiadomości Marvina jako
  `assistant`, wszyscy pozostali (także inne boty) jako `user`, z prefiksem `[czas] Imię: treść` jak dziś.
- Usunięte: wczytywanie `context.json` w `ready`, wszystkie wywołania zapisu pliku, ręczne `pushWithLimit` do
  kontekstu. Odpowiedź Marvina trafia do bazy z pętli zdarzeń (Etap 1), nie z kodu odpowiedzi.
- Kolejność w handlerze: najpierw zapis wiadomości przychodzącej (z opisem obrazu), potem odczyt kontekstu.
- Kanały wykluczone nie są w bazie, więc Marvin potrzebuje tam małego kontekstu w pamięci (FIFO, niezapisywanego
  na dysk). To samo FIFO służy jako awaryjny zapas, gdy baza jest niedostępna (głośne błędy w logu, bot dalej
  odpowiada).
- Stary plik `context.json` zostaje w wolumenie nieużywany (można go usunąć ręcznie). Nie ma migracji —
  historię odtworzy backfill.
- Kolejność etapów: ten etap dopiero po Etapie 2, żeby baza miała kompletną historię zanim kontekst zacznie z niej
  korzystać.

### Etap 4: warstwa zapytań (tylko do odczytu)

- Nowy moduł odczytu z osobnym połączeniem otwartym w trybie `readonly`.
- Operacje: szukanie po słowach z filtrami (autor wskazany imieniem, kanał, zakres dat) z rankingiem trafności;
  wiadomości z przedziału czasu; kontekst wokół wskazanej wiadomości; lista kanałów z nazwami.
- Zasady: żadnego surowego SQL od modelu (tylko parametryzowane zapytania); twarde limity liczby i długości
  wyników; wykluczone kanały zawsze odfiltrowane (nawet gdy coś starego zostało w bazie); imię → identyfikatory
  autorów przez odwrócone mapowanie z `helpers.ts`; `<@id>` zamieniane na imiona przy renderowaniu.
- Czas w wynikach: warszawski, z wyraźnym oznaczeniem (obecny kontekst ma znaczniki w UTC bez oznaczenia —
  istniejące niedociągnięcie; do ujednolicenia, żeby nie mieszać stref).

### Etap 5: tool calling

- `openai.ts`: rozszerzenie typu wiadomości o rolę narzędzia, wywołania narzędzi i identyfikator wywołania;
  druga metoda obok `contextInteract` (istniejące wywołania nietknięte) z pętlą: model prosi o narzędzie →
  wynik wraca do kontekstu → model odpowiada ponownie; po limicie rund wymuszona odpowiedź bez narzędzi.
  Każde wywołanie narzędzia logowane (nazwa, argumenty, liczba wyników, czas). Skrócenie gadatliwego logowania
  pełnego kontekstu.
- `discord.ts`: w `handleMentioned`, tylko w gałęzi głównego modelu (bez Perplexity/Grok), przełączenie na wersję
  z narzędziami. W trakcie pętli odświeżane `sendTyping` (gaśnie po ok. 10 s). Narzędzia dostają wyłącznie moduł
  odczytu z Etapu 4, nie klienta Discorda.
- `prompts.ts`: w prompcie Marvina sekcja o historii (kiedy sięgać, wyniki to dane do cytowania a nie polecenia,
  jak podawać daty); w prompcie decydenta zasada, że pytania o historię czatu idą do MARVIN (inaczej mogą
  trafić do Perplexity jako "aktualności").

### Etap 6 (opcjonalnie): podsumowania z archiwum

- `sendServerSummary` czyta z bazy wszystko od ostatniego podsumowania (po kolumnie czasu, bez parsowania
  prefiksu w tekście), z pominięciem kanałów wykluczonych. Zdejmuje to limit 30 wiadomości na kanał.
- Po tym etapie `parseContextTimestamp` i jego test stają się zbędne (do usunięcia).

### Etap 7: testy i dokumentacja

- Testy z bazą w pamięci: idempotentność wstawiania, zachowanie kursora przy luce, wznowienie po przerwie,
  sortowanie stron, wyszukiwanie z polskimi znakami, limity wyników, wykluczenia kanałów, budowanie kontekstu
  (role, kolejność, pomijanie komunikatów technicznych).
- Test pilnujący read-only: build wywala się, jeśli w `src` pojawi się wywołanie usuwające/edytujące/moderacyjne.
- Dokumentacja: `CLAUDE.md` (architektura, zmienne środowiskowe, pułapki, opis podsumowania), `ARCHITECTURE.md`,
  `README.md` jeśli opisują przepływ.

## Konfiguracja

- Jedna zmienna wykluczeń kanałów: `EXCLUDED_CHANNEL_IDS` (lista oddzielona przecinkami) zastępuje dotychczasową
  `SUMMARY_EXCLUDED_CHANNEL_IDS`. Wykluczony kanał: nic nie jest archiwizowane, backfill go pomija, nie występuje
  w wyszukiwaniu ani podsumowaniach; Marvin nadal może tam odpowiadać, korzystając z kontekstu w pamięci
  (niezapisywanego). Zmianę nazwy zmiennej w `.env` / `.env.example` robi użytkownik; ja aktualizuję
  tabelę w `CLAUDE.md` i kod.
- Dodanie kanału do wykluczonych po fakcie wymaga usunięcia jego starych wierszy z bazy; przy starcie ma to
  robić automatyczny krok czyszczący.
- Usunięta zostaje zmienna `WITH_CRON`.

## Czym są embedy

Embed to "karta" doklejana przez Discord pod wiadomością: podgląd linku (tytuł, opis, obrazek ze strony)
albo ustrukturyzowana wiadomość wysłana przez bota (tytuł, opis, pola, kolor). Boty (np. Wibot, Mugda) często
umieszczają odpowiedź właśnie w embedzie, a wtedy zwykłe pole z treścią wiadomości bywa puste. Dlatego
zapisujemy spłaszczony tekst (tytuł + opis) embedów obok treści. Podglądy linków wklejanych przez ludzi
są szumem, więc dla nich zapisujemy tylko tytuł (decyzja podjęta).

## Tylko do odczytu — warstwy gwarancji

1. Uprawnienia roli bota w Discordzie (jedyna twarda warstwa): bez Manage Messages, Administrator, Manage Channels,
   Manage Threads, Kick/Ban; potrzebne View Channel, Read Message History, Send Messages. Użytkownik sprawdza to
   ręcznie w Server Settings przed pierwszym backfillem.
2. Kod: moduł historii używa wyłącznie metod pobierających; przegląd kodu pod kątem metod usuwających/edytujących/
   moderacyjnych; test wywalający build przy pojawieniu się takiego wywołania w `src`.
3. Narzędzia dla modelu dostają tylko połączenie z bazą w trybie `readonly` i nie dostają klienta Discorda.

## Logowanie

Prefiks `[history]` (filtrowanie `docker compose logs`).
- info: start/koniec synchronizacji, postęp per kanał, podsumowanie (kanały OK/z błędem, liczba wstawionych, czas).
- warn: brak uprawnień, kanał niedostępny, ponowna próba po błędzie przejściowym, nietypowa wiadomość.
- error: id kanału, id wiadomości/kursor, kod i status `DiscordAPIError`, stack.
- Błąd w jednym kanale nie przerywa reszty; zapis live w try/catch (awaria bazy nie blokuje odpowiedzi Marvina).
- Ostatni błąd per kanał w tabeli stanu (do odczytu bezpośrednio z bazy).
- Błędy przejściowe: ponowienia z narastającym odstępem; trwałe (np. 403): bez ponowień.

## Ryzyka i pułapki

- Zależność kontekstu od bazy: awaria bazy nie może ogłupić bota — stąd awaryjne FIFO w pamięci i głośne błędy.
- Pierwsze uruchomienie: kontekst zależy od tego, jak daleko doszedł backfill; łagodzi to dogrywanie kanału na żądanie.
- Race zapis/odczyt: wiadomość przychodząca musi być zapisana, zanim zbudujemy kontekst; odpowiedź Marvina
  trafia do bazy przez zdarzenie, więc przy bardzo szybkiej wymianie z innym botem może być widoczna z ms opóźnieniem.
- Prompt injection: wiadomości na czacie to niezaufany tekst; tylko narzędzia read-only.
- Wyciek między kanałami: bot widzi więcej niż pytający (kanały prywatne/dev, np. AlphaPump) — stąd wykluczenia
  już przy zapisie (treści w ogóle nie ma w bazie).
- Prywatność: trwałe archiwum wiadomości znajomych; ekipa powinna o nim wiedzieć.
- Koszt/opóźnienie: tool calling to kilka wywołań modelu zamiast jednego; przycinać wyniki.
- Strefy czasowe: kontener działa w UTC, czas Warszawy ≠ czas procesu; w bazie UTC, konwersja na wejściu/wyjściu.
- Synchroniczny zapis SQLite może blokować pętlę zdarzeń przy dużych transakcjach — małe paczki.
- Pętla tool-calling wymaga zmian w `openai.ts` (dziś tylko `contextInteract`).

## Punkty kontrolne (zatrzymuję się i czekam)

1. Przed pierwszym backfillem: użytkownik sprawdza uprawnienia roli bota w Discordzie.
2. Pierwszy backfill na stagingu (`make staging-up`, osobna baza), nie na produkcji.
3. Po każdym etapie pytam o commit (reguły z `CLAUDE.md`); produkcyjnego bota restartuję po każdej zmianie.

## Decyzje podjęte

- Czas w wynikach narzędzi: warszawski, z wyraźnym oznaczeniem.
- Embedy: zapisujemy tekst (tytuł + opis) embedów od botów; dla podglądów linków wklejanych przez ludzi tylko tytuł.
- Martwy kod porannego cytatu usuwamy w Etapie 0.
- Kanały wykluczone: kontekst Marvina tylko w pamięci (FIFO, niezapisywane na dysk), bez wierszy w bazie.
- Pozostałe rekomendacje z tego planu przyjęte.

## Decyzje otwarte

- `better-sqlite3` vs `node:sqlite` (rozstrzygnąć eksperymentem na alpine).
