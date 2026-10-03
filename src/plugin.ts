import streamDeck from "@elgato/streamdeck";

import { UsageDial } from "./actions/dial";

streamDeck.logger.setLevel("debug");
// SDK 3 defaults to the 7.1 settings lifecycle; the legacy one keeps Stream Deck 6.9+ supported.
streamDeck.settings.useLegacySettingsBehavior = true;
streamDeck.logger.info("claudeusage plugin started.");

streamDeck.actions.registerAction(new UsageDial());
streamDeck.connect();
