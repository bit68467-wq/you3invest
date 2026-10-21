# API per Render

> Il backend di deposito Render esportabile è in `render-backend/`. La configurazione di produzione usa PostgreSQL, password scrypt, sessioni server-side e revisione manuale dei depositi. Le note storiche sotto descrivono il mock esistente e il vecchio contratto: non configurare il vecchio `server.js` Render per accettare fondi. Seguire `render-backend/README.md` per il bundle nuovo e i limiti delle API non ancora migrate.

## Modalità attuale

Il preview Websim usa `mock-api.js` solo per la dimostrazione locale. Il deploy Render usa `render-backend/server.js` e PostgreSQL; autenticazione, sessioni e scritture finanziarie non fanno fallback a localStorage. Render implementa deposito con commissione, investimenti e valorizzazione, riscatto guadagni, chiusura anticipata, wallet/PIN di prelievo e liquidazione admin dei prelievi. Le altre funzioni non migrate restano indisponibili (HTTP 501) in produzione.

Per Render, impostare il comando di avvio a `node render-backend/server.js` così il backend serve anche i file statici con API same-origin. Nel preview Websim il mock resta attivo esclusivamente per la demo. La modalità Render non carica l'adattatore mock.

## Contratto richiesto al servizio

- `POST /api/auth/register` — `{ username, email, password, language? }`; crea un ID account univoco e restituisce `{ token, account }`.
- `POST /api/auth/login` — `{ email, password }`; verifica le credenziali e restituisce `{ token, account }`.
- `POST /api/auth/logout` — invalida solo la sessione Bearer corrente; non elimina l'account o i suoi dati.
- `POST /api/auth/password-reset/request` — `{ email, language, redirectUrl }`; risponde sempre con esito generico per non rivelare se l’email è registrata. Il servizio genera un token casuale monouso, ne conserva solo l’hash con scadenza breve e invia all’indirizzo registrato un link all’URL di ritorno con parametro reset. Accetta solo URL di ritorno autorizzati, limita le richieste e risponde allo stesso modo per account presenti o assenti. L’email deve essere inviata dal backend tramite un provider configurato; non inviare mai il token in risposta API o nei log.
- `POST /api/auth/password-reset/confirm` — `{ token, password }`; verifica hash, scadenza e uso singolo del token, aggiorna la password e revoca tutte le sessioni dell’account.
- `PUT /api/auth/password` — `{ currentPassword, newPassword }`; verifica la password attuale e aggiorna l’hash della password.
- `PUT /api/auth/withdrawal-password` — `{ loginPassword, pin }`; verifica la password di accesso, richiede un PIN di sei cifre distinto e ne salva l’hash.
- `GET /api/account` — restituisce solo l’account legato alla sessione, con `id`, `revision`, `wallet` (`deposit`, `earnings`, `unlocked`), `investments`, `transactions`, `depositRequests`, `withdrawalRequests`, `preferences`, `withdrawalWallet`, `walletChangeRequests` e `withdrawalPinSet`.
- `GET /api/deposit-addresses` — restituisce gli indirizzi pubblici di deposito configurati per rete.
- `POST /api/withdrawal-wallet` — collega il primo wallet; per un wallet già collegato crea una richiesta di modifica in attesa dell’amministratore.
- `POST /api/admin/wallet-change` — `{ accountId, requestId, decision }`; approva o rifiuta una modifica wallet, solo per amministratore.
- `PUT /api/admin/deposit-addresses` — `{ addresses: { bep20, bitcoin, trc20 } }`; configura gli indirizzi pubblici di ricezione, solo per amministratore.
- `GET /api/admin/accounts` — elenco account, solo per amministratore; mantiene la funzione admin di visualizzazione e gestione degli account.
- `PUT /api/account` — aggiornamento dell’account corrente e delle sue preferenze con `revision` per rilevare modifiche concorrenti.
- `PUT /api/admin/account` — aggiornamento amministrativo di un altro account, con `revision`; solo per amministratore.
- `POST /api/admin/rewards/credit` — `{ accountId, points, spins }`; accredita punti H9 e giri bonus a un account, solo per amministratore.
- `DELETE /api/admin/accounts` — elimina gli account locali, solo per amministratore e su azione esplicita; non è l'operazione di logout.
- `POST /api/deposits` — `{ amount, network, depositAddress, txHash }`; `amount` è espresso in USD e arrotondato ai centesimi. Il servizio controlla l’indirizzo e registra la richiesta per revisione. Alla conferma l’admin inserisce l’importo lordo verificato; il server trattiene l’1% e accredita il 99% netto.
- `POST /api/withdrawals` — { amount, source, network, address, pin }; source è `earnings` (commissione 4%, comportamento attuale) oppure `unlocked` (capitale svincolato, commissione 20%). Il lordo viene riservato dal rispettivo saldo; un rifiuto restituisce il lordo allo stesso saldo senza commissioni.
- `POST /api/investments/close` — `{ investmentId, quotes }`; chiude il piano attivo e accredita `max(0, valore portafoglio - penale 65% - guadagni generati)`, includendo gli utili già riscattati.
- `GET /api/admin/platform-fees` — riepilogo amministrativo delle commissioni registrate.
- `POST /api/earnings/redeem` — `{ investmentId?, quotes? }`; riscatta solo il profitto corrente sopra il capitale iniziale vincolato, trattiene l’1% sul lordo e accredita il 99% netto. Con `investmentId` opera sul singolo contratto; senza ID riscatta tutti i profitti disponibili. Registra lordo, commissione e netto.
- `POST /api/investments` — `{ amount, planId, quotes? }`; il server verifica il saldo deposito e stabilisce importo, piano, data iniziale, scadenza fissa e snapshot delle percentuali `allocation` e dei prezzi correnti.
- `POST /api/investments/add-funds` — `{ investmentId, amount }`; aggiunge fondi dal saldo deposito a un contratto attivo, mantenendone scadenza e condizioni; il valore aggiunto viene incluso nella normale valorizzazione e liquidazione del contratto.
- `POST /api/rewards/purchase` — `{ rewardId }`; addebita punti e attiva un bonus temporaneo o accredita un coupon al saldo locale.
- `POST /api/rewards/spin` — un premio punti al giorno; il server deve verificare giorno e probabilità e registrare l'esito in modo atomico.

Il servizio deve conservare password con hash salato e associare ogni token a un singolo account e a una sessione indipendente. Le rotte utente devono autorizzare e limitare ogni lettura e modifica all'account associato al token, senza sessioni condivise tra utenti. Solo le rotte `/api/admin/*` possono operare sugli account altrui e devono verificare il ruolo admin lato server. Il logout invalida la sola sessione corrente senza cancellare dati utente. Le operazioni sul saldo devono essere atomiche.

L’account può inoltre includere `preferences` (`language`, `theme`, `notificationsSeenAt`), `withdrawalWallet` (`network`, `address`), `walletChangeRequests` e `withdrawalPinSet`. Gli hash del PIN e della password di accesso non devono mai essere restituiti dalle rotte account. La lingua scelta dalla pagina iniziale viene conservata localmente e applicata all’account durante la registrazione; per un account esistente prevale la lingua salvata nelle preferenze.

Gli indirizzi di deposito sono indirizzi pubblici forniti dall’infrastruttura wallet della piattaforma e configurati per rete. Il prototipo locale li conserva nel browser dell’amministratore; non genera chiavi o indirizzi blockchain e non deve essere usato per inviare fondi. Per un servizio reale la configurazione va sostituita con indirizzi provisionati e gestiti dal servizio di custodia.

## Punti H9 e premi

In questa configurazione, 2.500 punti H9 corrispondono al valore indicativo di 1 USDT. Gli inviti assegnano una quantità fissa di punti alla creazione dell’account e non dipendono dall’attività finanziaria dell’invitato. I coupon aggiungono un accredito USDT al saldo guadagni locale; non è collegato un servizio di pagamento.

La ruota assegna punti una volta al giorno secondo i pesi in `rewards-model.js`. I cinque premi con valore superiore a 10 USDT hanno un ticket ciascuno su 50.000.000, per una probabilità combinata di 1 su 10.000.000. Il mock salva ogni estrazione e impedisce una seconda estrazione nello stesso giorno UTC.

## Valorizzazione di mercato, protezione e riscatto

I piani disponibili durano 6, 12, 24, 36 o 60 mesi. Alla sottoscrizione viene salvata la data di scadenza calcolata sul calendario; variazioni di mercato o sospensioni non la spostano. Il mock aggiorna il valore usando il movimento relativo dei prezzi reali del paniere rispetto all'ultima valorizzazione. I rendimenti si compongono moltiplicativamente perché la variazione successiva si applica al valore di mercato corrente; non viene promesso né accreditato un tasso giornaliero fisso.

Il capitale iniziale resta vincolato e definisce la soglia per il riscatto. Solo la parte del valore del portafoglio superiore al capitale iniziale è riscattabile con `POST /api/earnings/redeem`; il server trattiene l’1%, sposta il netto al saldo guadagni e riduce il valore investito del lordo riscattato, mantenendo il capitale esposto al mercato. La chiusura anticipata restituisce il 35% del valore corrente meno tutti i guadagni generati (riscattati o ancora nel piano), con importo minimo zero; il rimborso confluisce nel saldo capitale svincolato, separato dal saldo deposito e prelevabile con commissione del 20%. Una perdita pari o superiore al 20% sospende la valorizzazione a mercato al limite di protezione; il tracking dei prezzi prosegue per identificare il recupero e riattivare il piano quando supera la soglia. Alla scadenza, il valore corrente (o la soglia di protezione se il piano è sospeso) confluisce nel saldo capitale svincolato.

Il mock browser ricalcola i portafogli al refresh dei prezzi e quando un account viene caricato. La dashboard richiede nuovi dati ogni 60 secondi mentre la pagina è visibile. Render recupera le quotazioni lato server e ignora i prezzi forniti dal client nelle operazioni finanziarie; i feed esterni determinano la frequenza effettiva delle variazioni.

## Dati e trasferimenti

Il frontend e il backend locale non verificano transazioni blockchain e non inviano fondi. Il database locale del browser non sincronizza dispositivi; la condivisione tra browser inizierà quando `RENDER_API_BASE` verrà collegato al servizio esterno.
