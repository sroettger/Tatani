# Android flashcard notifications
- [ ] Replace daily frequency with cards per hour and minute-based scheduling.
- [ ] Block new deliveries until the previous card is reviewed, including concurrent sends.
- [ ] Test frequency, pending-card blocking, and settings persistence.
- [x] Add opt-in, local hourly schedule, and test notification controls.
- [x] Store device subscriptions and send studied flashcards through Firebase.
- [x] Add authenticated reveal/review page and hourly delivery schedule.
- [x] Test language isolation, scheduling, review persistence, and authenticated browser flow.
- [ ] Verify actual Android push delivery — requires permission and registration from the user's phone; sandbox Chromium refuses push subscription.