const _ = require('lodash');
const BREAD = require('./bread');
const debug = require('@tryghost/debug')('custom-theme-settings-service');

module.exports = class CustomThemeSettingsService {
    /**
     * @param {Object} options
     * @param {any} options.model - Bookshelf-like model instance for storing theme setting key/value pairs
     * @param {import('./cache')} options.cache - Instance of a custom key/value pair cache
     */
    constructor({model, cache}) {
        this.activeThemeName = null;

        /** @private */
        this.repository = new BREAD({model});
        this.valueCache = cache;
        this.activeThemeSettings = {};
    }

    /**
     * The service only deals with one theme at a time,
     * that theme is changed by calling this method with the output from gscan
     *
     * @param {Object} theme - checked theme output from gscan
     */
    async activateTheme(theme) {
        this.activeThemeName = theme.name;

        // add/remove/edit key/value records in the respository to match theme settings
        const settings = await this.syncRepositoryWithTheme(theme);

        // populate the shared cache with all key/value pairs for this theme
        this.populateValueCacheForTheme(theme, settings);
        // populate the cache used for exposing full setting details for editing
        this.populateInternalCacheForTheme(theme, settings);
    }

    /**
     * Convert the key'd internal cache object to an array suitable for use with Ghost's API
     */
    listSettings() {
        const settingObjects = Object.entries(this.activeThemeSettings).map(([key, setting]) => {
            return Object.assign({}, setting, {key});
        });

        return settingObjects;
    }

    // Private -----------------------------------------------------------------

    /**
     * @param {Object} theme - checked theme output from gscan
     * @private
     */
    async syncRepositoryWithTheme(theme) {
        const themeSettings = theme.customSettings || {};

        const settingsCollection = await this.repository.browse({theme: theme.themeName});
        let knownSettings = settingsCollection.toJSON();

        // exit early if there's nothing to sync for this theme
        if (knownSettings.length === 0 && _.isEmpty(themeSettings)) {
            return;
        }

        let removedIds = [];

        // sync any knownSettings that have changed in the theme
        for (const knownSetting of knownSettings) {
            const themeSetting = themeSettings[knownSetting.key];

            const hasBeenRemoved = !themeSetting;
            const hasChangedType = themeSetting && themeSetting.type !== knownSetting.type;

            if (hasBeenRemoved || hasChangedType) {
                debug(`Removing custom theme setting '${theme.name}.${themeSetting.key}' - ${hasBeenRemoved ? 'not found in theme' : 'type changed'}`);
                await this.repository.destroy({id: knownSetting.id});
                removedIds.push(knownSetting.id);
                return;
            }

            // replace value with default if it's not a valid select option
            if (themeSetting.options && !themeSetting.options.includes(knownSetting.value)) {
                debug(`Resetting custom theme setting value '${theme.name}.${themeSetting.key}' - "${knownSetting.value}" is not a valid option`);
                await this.repository.edit({value: themeSetting.default}, {id: knownSetting.id});
            }
        }

        // clean up any removed knownSettings now that we've finished looping over them
        knownSettings = knownSettings.filter(setting => !removedIds.includes(setting.id));

        // add any new settings found in theme (or re-add settings that were removed due to type change)
        const knownSettingsKeys = knownSettings.map(setting => setting.key);

        for (const [key, setting] of Object.entries(themeSettings)) {
            if (!knownSettingsKeys.includes(key)) {
                const newSettingValues = {
                    theme: theme.name,
                    key,
                    type: setting.type,
                    value: setting.default
                };

                debug(`Adding custom theme setting '${theme.name}.${key}'`);
                await this.repository.add(newSettingValues);
            }
        }

        const updatedSettingsCollection = await this.repository.browse({theme: theme.themeName});
        return updatedSettingsCollection.toJSON();
    }

    /**
     * @param {Object} theme - checked theme output from gscan
     * @param {Array} settings - theme settings fetched from repository
     * @private
     */
    populateValueCacheForTheme(theme, settings) {
        if (_.isEmpty(theme.customSettings)) {
            this.valueCache.populate([]);
            return;
        }

        this.valueCache.populate(settings);
    }

    /**
     * @param {Object} theme - checked theme output from gscan
     * @param {Array} settings - theme settings fetched from repository
     * @private
     */
    populateInternalCacheForTheme(theme, settings) {
        if (_.isEmpty(theme.customSettings)) {
            this.activeThemeSettings = new Map();
            return;
        }

        const settingValues = settings.reduce((acc, setting) => {
            acc[setting.key] = setting;
            return acc;
        }, new Object());

        const activeThemeSettings = new Object();

        for (const [key, setting] of Object.entries(theme.customSettings)) {
            // value comes from the stored key/value pairs rather than theme, we don't need the ID - theme name + key is enough
            activeThemeSettings[key] = Object.assign({}, setting, {
                id: settingValues[key].id,
                value: settingValues[key].value
            });
        }

        this.activeThemeSettings = activeThemeSettings;
    }
};
