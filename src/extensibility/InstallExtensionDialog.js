/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50, regexp: true */
/*global define, brackets, window, $, PathUtils, Mustache, document */

define(function (require, exports, module) {
    "use strict";
    
    require("thirdparty/path-utils/path-utils.min");

    var Dialogs                = require("widgets/Dialogs"),
        StringUtils            = require("utils/StringUtils"),
        Strings                = require("strings"),
        Commands               = require("command/Commands"),
        CommandManager         = require("command/CommandManager"),
        KeyEvent               = require("utils/KeyEvent"),
        Package                = require("extensibility/Package"),
        InstallDialogTemplate  = require("text!extensibility/install-extension-dialog.html");

    var STATE_CLOSED            = 0,
        STATE_START             = 1,
        STATE_VALID_URL         = 2,
        STATE_INSTALLING        = 3,
        STATE_INSTALLED         = 4,
        STATE_INSTALL_FAILED    = 5,
        STATE_INSTALL_CANCELLED = 6;
    
    /** 
     * @constructor
     * Creates a new extension installer dialog.
     * @param {{install: function(url), cancel: function()}} installer The installer backend to use.
     */
    function InstallExtensionDialog(installer) {
        this._installer = installer;
        this._state = STATE_CLOSED;
    }
    
    /** @type {jQuery} The dialog root. */
    InstallExtensionDialog.prototype.$dlg = null;
    
    /** @type {jQuery} The url input field. */
    InstallExtensionDialog.prototype.$url = null;
    
    /** @type {jQuery} The ok button. */
    InstallExtensionDialog.prototype.$okButton = null;
    
    /** @type {jQuery} The cancel button. */
    InstallExtensionDialog.prototype.$cancelButton = null;
    
    /** @type {jQuery} The area containing the url input label and field. */
    InstallExtensionDialog.prototype.$inputArea = null;
    
    /** @type {jQuery} The area containing the installation message and spinner. */
    InstallExtensionDialog.prototype.$msgArea = null;
    
    /** @type {jQuery} The span containing the installation message. */
    InstallExtensionDialog.prototype.$msg = null;
    
    /** @type {jQuery} The installation progress spinner. */
    InstallExtensionDialog.prototype.$spinner = null;
    
    /** @type {$.Deferred} A deferred that's resolved/rejected when the dialog is closed and
        something has/hasn't been installed successfully. */
    InstallExtensionDialog.prototype._dialogDeferred = null;
    
    
    /** @type {{install: function(url), cancel: function()}} installer The installer backend for this dialog. */
    InstallExtensionDialog.prototype._installer = null;
    
    /** @type {number} The current state of the dialog; one of the STATE_* constants above. */
    InstallExtensionDialog.prototype._state = null;
    
    /**
     * @private
     * Transitions the dialog into a new state as the installation proceeds.
     * @param {number} newState The state to transition into; one of the STATE_* variables.
     */
    InstallExtensionDialog.prototype._enterState = function (newState) {
        var url,
            msg,
            self = this,
            prevState = this._state;
        
        // Store the new state up front in case some of the processing below ends up changing
        // the state again immediately.
        this._state = newState;
        
        switch (newState) {
        case STATE_START:
            // This should match the default appearance of the dialog when it first opens.
            this.$spinner.removeClass("spin");
            this.$msgArea.hide();
            this.$inputArea.show();
            this.$okButton
                .attr("disabled", "disabled")
                .text(Strings.INSTALL);
            break;
                
        case STATE_VALID_URL:
            this.$okButton.removeAttr("disabled");
            break;
            
        case STATE_INSTALLING:
            url = this.$url.val();
            this.$inputArea.hide();
            this.$msg.text(StringUtils.format(Strings.INSTALLING_FROM, url));
            this.$spinner.addClass("spin");
            this.$msgArea.show();
            this.$okButton.attr("disabled", "disabled");
            this._installer.install(url)
                .done(function () {
                    self._enterState(STATE_INSTALLED);
                })
                .fail(function (err) {
                    console.error("Failed to install:", err);
                    self._enterState(STATE_INSTALL_FAILED);
                });
            break;
            
        case STATE_INSTALLED:
        case STATE_INSTALL_FAILED:
        case STATE_INSTALL_CANCELLED:
            if (newState === STATE_INSTALL_CANCELLED) {
                // TODO: do we need to wait for acknowledgement? That will require adding a new
                // "waiting for cancelled" state.
                this._installer.cancel();
            }
                
            this.$spinner.removeClass("spin");
            if (newState === STATE_INSTALLED) {
                msg = Strings.INSTALL_SUCCEEDED;
            } else if (newState === STATE_INSTALL_FAILED) {
                // TODO: show error message from backend--how do we pass this?
                msg = Strings.INSTALL_FAILED;
            } else {
                msg = Strings.INSTALL_CANCELLED;
            }
            this.$msg.text(msg);
            this.$okButton
                .removeAttr("disabled")
                .text(Strings.CLOSE);
            this.$cancelButton.hide();
            break;
            
        case STATE_CLOSED:
            $(document.body).off(".installDialog");
            
           // Only resolve as successful if we actually installed something.
            Dialogs.cancelModalDialogIfOpen("install-extension-dialog");
            if (prevState === STATE_INSTALLED) {
                this._dialogDeferred.resolve();
            } else {
                this._dialogDeferred.reject();
            }
            break;
        }
    };

    /**
     * @private
     * Handle a click on the Cancel button, which either cancels an ongoing installation (leaving
     * the dialog open), or closes the dialog if no installation is in progress.
     */
    InstallExtensionDialog.prototype._handleCancel = function () {
        if (this._state === STATE_INSTALLING) {
            this._enterState(STATE_INSTALL_CANCELLED);
        } else {
            this._enterState(STATE_CLOSED);
        }
    };
    
    /**
     * @private
     * Handle a click on the default button, which is "Install" while we're waiting for the
     * user to enter a URL, and "Close" once we've successfully finished installation.
     */
    InstallExtensionDialog.prototype._handleOk = function () {
        if (this._state === STATE_INSTALLED ||
                this._state === STATE_INSTALL_FAILED ||
                this._state === STATE_INSTALL_CANCELLED) {
            // In these end states, this is a "Close" button: just close the dialog and indicate
            // success.
            this._enterState(STATE_CLOSED);
        } else if (this._state === STATE_VALID_URL) {
            this._enterState(STATE_INSTALLING);
        }
    };
    
    /**
     * @private
     * Handle key up events on the document. We use this to detect the Esc key.
     */
    InstallExtensionDialog.prototype._handleKeyUp = function (e) {
        if (e.keyCode === KeyEvent.DOM_VK_ESCAPE) {
            this._handleCancel();
        }
    };
    
    /**
     * @private
     * Handle typing in the URL field.
     */
    InstallExtensionDialog.prototype._handleUrlInput = function () {
        var url = this.$url.val(),
            valid = (url !== "");
        if (!valid && this._state === STATE_VALID_URL) {
            this._enterState(STATE_START);
        } else if (valid && this._state === STATE_START) {
            this._enterState(STATE_VALID_URL);
        }
    };


    /**
     * @private
     * Sets the installer backend.
     * @param {{install: function(string): $.Promise, cancel: function()}} installer
     *     The installer backend object to use. Must define two functions:
     *     install(url): takes the URL of the extension to install, and returns a promise
     *         that's resolved or rejected when the installation succeeds or fails.
     *     cancel(): cancels an ongoing installation.
     */
    InstallExtensionDialog.prototype._setInstaller = function (installer) {
        this._installer = installer;
    };
 
    /**
     * @private
     * Returns the jQuery objects for various dialog fileds. For unit testing only.
     * @return {object} fields An object containing "dlg", "okButton", "cancelButton", and "url" fields.
     */
    InstallExtensionDialog.prototype._getFields = function () {
        return {
            $dlg: this.$dlg,
            $okButton: this.$okButton,
            $cancelButton: this.$cancelButton,
            $url: this.$url
        };
    };
    
    /**
     * @private
     * Closes the dialog if it's not already closed. For unit testing only.
     */
    InstallExtensionDialog.prototype._close = function () {
        if (this._state !== STATE_CLOSED) {
            this._enterState(STATE_CLOSED);
        }
    };

    /**
     * Initialize and show the dialog.
     * @return {$.Promise} A promise object that will be resolved when the selected extension
     *     has finished installing, or rejected if the dialog is cancelled.
     */
    InstallExtensionDialog.prototype.show = function () {
        if (this._state !== STATE_CLOSED) {
            // Somehow the dialog got invoked twice. Just ignore this.
            return;
        }
        
        // We ignore the promise returned by showModalDialogUsingTemplate, since we're managing the 
        // lifecycle of the dialog ourselves.
        Dialogs.showModalDialogUsingTemplate(
            Mustache.render(InstallDialogTemplate, Strings),
            null,
            null,
            false
        );
        
        this.$dlg          = $(".install-extension-dialog.instance");
        this.$url          = this.$dlg.find(".url").focus();
        this.$okButton     = this.$dlg.find(".dialog-button[data-button-id='ok']");
        this.$cancelButton = this.$dlg.find(".dialog-button[data-button-id='cancel']");
        this.$inputArea    = this.$dlg.find(".input-field");
        this.$msgArea      = this.$dlg.find(".message-field");
        this.$msg          = this.$msgArea.find(".message");
        this.$spinner      = this.$msgArea.find(".spinner");

        this.$okButton.on("click", this._handleOk.bind(this));
        this.$cancelButton.on("click", this._handleCancel.bind(this));
        this.$url.on("input", this._handleUrlInput.bind(this));
        $(document.body).on("keyup.installDialog", this._handleKeyUp.bind(this));
        
        this._enterState(STATE_START);

        this._dialogDeferred = new $.Deferred();
        return this._dialogDeferred.promise();
    };

    function RealInstaller() { }
    RealInstaller.prototype.install = function (url) {
        return Package.download(url);
    };
    RealInstaller.prototype.cancel = function () {
        console.error("Not supported yet!");
    };
    
    /**
     * @private
     * Show a dialog that allows the user to enter the URL of an extension ZIP file to install.
     * @return {$.Promise} A promise object that will be resolved when the selected extension
     *     has finished installing, or rejected if the dialog is cancelled.
     */
    function _showDialog(installer) {
        var dlg = new InstallExtensionDialog(new RealInstaller());
        return dlg.show();
    }
    
    CommandManager.register(Strings.CMD_INSTALL_EXTENSION, Commands.FILE_INSTALL_EXTENSION, _showDialog);

    // Exposed for unit testing only
    exports._Dialog = InstallExtensionDialog;
});