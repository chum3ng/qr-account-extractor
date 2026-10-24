/*
 * EMVCo QR Account Extractor & Hash Matcher
 * AngularJS 1.x application. All processing is local to the browser.
 */
(function () {
    'use strict';

    var TAB = '\t';
    var LINE_BREAK = /\r\n|\n/;
    var MAX_ERRORS_SHOWN = 200;

    var STATUS = {
        SUCCESS: 'SUCCESS',
        NO_SUPPORTED_TAG: 'NO_SUPPORTED_TAG',
        ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
        INVALID_TLV: 'INVALID_TLV',
        INVALID_INPUT: 'INVALID_INPUT'
    };

    angular.module('qrAccountTool', [])

        /* ------------------------------------------------------------------
         * TlvParser: TLV parsing, account extraction, bulk input processing
         * ------------------------------------------------------------------ */
        .factory('TlvParser', function () {

            /**
             * Parse a TLV string sequentially.
             * Returns { fields: [{tag, length, value}], error: null | {code, message} }.
             * Never reads out of bounds; every iteration advances by at least 4 chars.
             */
            function parseTlv(data) {
                var fields = [];
                var text = String(data);
                var total = text.length;
                var pos = 0;

                while (pos < total) {
                    if (total - pos < 4) {
                        return {
                            fields: fields,
                            error: {
                                code: 'TRUNCATED_HEADER',
                                message: 'Incomplete TLV header at position ' + pos + '.'
                            }
                        };
                    }

                    var tag = text.substr(pos, 2);
                    var lengthText = text.substr(pos + 2, 2);

                    if (!/^[0-9]{2}$/.test(tag)) {
                        return {
                            fields: fields,
                            error: {
                                code: 'INVALID_TAG',
                                message: 'Non-numeric TLV tag at position ' + pos + '.'
                            }
                        };
                    }
                    if (!/^[0-9]{2}$/.test(lengthText)) {
                        return {
                            fields: fields,
                            error: {
                                code: 'INVALID_LENGTH',
                                message: 'Non-numeric length for tag ' + tag + ' at position ' + pos + '.'
                            }
                        };
                    }

                    var length = parseInt(lengthText, 10);
                    var start = pos + 4;
                    var end = start + length;

                    if (end > total) {
                        return {
                            fields: fields,
                            error: {
                                code: 'TRUNCATED_VALUE',
                                message: 'Tag ' + tag + ' declares length ' + length +
                                    ' but only ' + (total - start) + ' characters remain.'
                            }
                        };
                    }

                    fields.push({
                        tag: tag,
                        length: length,
                        value: text.substring(start, end)
                    });
                    pos = end;
                }

                return { fields: fields, error: null };
            }

            /** First field with the given tag, or null. */
            function findField(fields, tag) {
                for (var i = 0; i < fields.length; i++) {
                    if (fields[i].tag === tag) {
                        return fields[i];
                    }
                }
                return null;
            }

            /** Non-empty string value of a subtag, or null when absent or empty. */
            function subValue(fields, tag) {
                var field = findField(fields, tag);
                if (field === null || field.value === '') {
                    return null;
                }
                return field.value;
            }

            /**
             * Extract accounts from one QR payload.
             * Returns { status, accounts: [], message }.
             * Rule A: top-level 42 (subtag 02 = KHR, 03 = USD) has priority, no fallback.
             * Rule B: only without top-level 42, top-level 29 subtag 01.
             */
            function extractAccounts(qrCode) {
                var top = parseTlv(qrCode);
                if (top.error) {
                    return {
                        status: STATUS.INVALID_TLV,
                        accounts: [],
                        message: 'Invalid TLV structure: ' + top.error.message
                    };
                }

                var tag42 = findField(top.fields, '42');
                if (tag42 !== null) {
                    var nested42 = parseTlv(tag42.value);
                    if (nested42.error) {
                        return {
                            status: STATUS.INVALID_TLV,
                            accounts: [],
                            message: 'Invalid nested TLV in tag 42: ' + nested42.error.message
                        };
                    }
                    var accounts42 = [];
                    var khr = subValue(nested42.fields, '02');
                    var usd = subValue(nested42.fields, '03');
                    if (khr !== null) { accounts42.push(khr); }
                    if (usd !== null) { accounts42.push(usd); }
                    if (accounts42.length === 0) {
                        return {
                            status: STATUS.ACCOUNT_NOT_FOUND,
                            accounts: [],
                            message: 'Tag 42 present but has no subtag 02 or 03 account (tag 29 not used as fallback).'
                        };
                    }
                    return { status: STATUS.SUCCESS, accounts: accounts42, message: '' };
                }

                var tag29 = findField(top.fields, '29');
                if (tag29 !== null) {
                    var nested29 = parseTlv(tag29.value);
                    if (nested29.error) {
                        return {
                            status: STATUS.INVALID_TLV,
                            accounts: [],
                            message: 'Invalid nested TLV in tag 29: ' + nested29.error.message
                        };
                    }
                    var account29 = subValue(nested29.fields, '01');
                    if (account29 === null) {
                        return {
                            status: STATUS.ACCOUNT_NOT_FOUND,
                            accounts: [],
                            message: 'Tag 29 present but has no subtag 01 account.'
                        };
                    }
                    return { status: STATUS.SUCCESS, accounts: [account29], message: '' };
                }

                return {
                    status: STATUS.NO_SUPPORTED_TAG,
                    accounts: [],
                    message: 'No top-level tag 42 or tag 29 found.'
                };
            }

            /**
             * Process the full "hash[TAB]qrcode" input.
             * Returns { records, outputText, stats, errors, errorCount }.
             */
            function processInput(input) {
                var lines = String(input).split(LINE_BREAK);
                var records = [];
                var outputLines = [];
                var errors = [];
                var stats = {
                    inputRecords: 0,
                    successRecords: 0,
                    accountCount: 0,
                    noAccountRecords: 0,
                    failedRecords: 0
                };

                function fail(lineNumber, status, message) {
                    stats.failedRecords++;
                    errors.push({
                        line: lineNumber,
                        status: status,
                        severity: 'error',
                        message: message
                    });
                }

                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (line === '') {
                        continue;
                    }
                    var lineNumber = i + 1;
                    stats.inputRecords++;

                    var tabIndex = line.indexOf(TAB);
                    if (tabIndex < 0) {
                        fail(lineNumber, STATUS.INVALID_INPUT, 'Missing tab delimiter between hash and QR payload.');
                        continue;
                    }
                    var hash = line.substring(0, tabIndex);
                    var qr = line.substring(tabIndex + 1);
                    if (hash === '') {
                        fail(lineNumber, STATUS.INVALID_INPUT, 'Empty hash.');
                        continue;
                    }
                    if (qr === '') {
                        fail(lineNumber, STATUS.INVALID_INPUT, 'Empty QR payload.');
                        continue;
                    }

                    var result = extractAccounts(qr);

                    if (result.status === STATUS.INVALID_TLV) {
                        fail(lineNumber, result.status, result.message);
                        continue;
                    }

                    records.push({
                        line: lineNumber,
                        hash: hash,
                        status: result.status,
                        accounts: result.accounts
                    });
                    outputLines.push(hash + TAB + result.accounts.join(','));

                    if (result.status === STATUS.SUCCESS) {
                        stats.successRecords++;
                        stats.accountCount += result.accounts.length;
                    } else {
                        stats.noAccountRecords++;
                        errors.push({
                            line: lineNumber,
                            status: result.status,
                            severity: 'warning',
                            message: result.message
                        });
                    }
                }

                errors.sort(function (a, b) { return a.line - b.line; });

                return {
                    records: records,
                    outputText: outputLines.join('\n'),
                    stats: stats,
                    errors: errors
                };
            }

            return {
                STATUS: STATUS,
                parseTlv: parseTlv,
                extractAccounts: extractAccounts,
                processInput: processInput
            };
        })

        /* ------------------------------------------------------------------
         * AccountMatcher: target parsing and exact matching
         * ------------------------------------------------------------------ */
        .factory('AccountMatcher', function () {

            /** One account per line, trimmed, blanks removed, duplicates removed. */
            function parseTargetAccounts(input) {
                var lines = String(input).split(/\r\n|\n|\r/);
                var set = new Set();
                var accounts = [];
                for (var i = 0; i < lines.length; i++) {
                    var value = lines[i].trim();
                    if (value === '' || set.has(value)) {
                        continue;
                    }
                    set.add(value);
                    accounts.push(value);
                }
                return { accounts: accounts, set: set };
            }

            /** Exact, case-sensitive matching against extracted records. */
            function matchAccounts(records, targetSet) {
                var lines = [];
                var uniqueMatched = new Set();

                for (var i = 0; i < records.length; i++) {
                    var record = records[i];
                    if (record.status !== STATUS.SUCCESS || record.accounts.length === 0) {
                        continue;
                    }
                    var matched = [];
                    for (var j = 0; j < record.accounts.length; j++) {
                        if (targetSet.has(record.accounts[j])) {
                            matched.push(record.accounts[j]);
                            uniqueMatched.add(record.accounts[j]);
                        }
                    }
                    if (matched.length > 0) {
                        lines.push(record.hash + TAB + matched.join(','));
                    }
                }

                return {
                    outputText: lines.join('\n'),
                    recordCount: lines.length,
                    uniqueMatchedCount: uniqueMatched.size
                };
            }

            return {
                parseTargetAccounts: parseTargetAccounts,
                matchAccounts: matchAccounts
            };
        })

        /* ------------------------------------------------------------------
         * ClipboardService: Clipboard API with execCommand fallback
         * ------------------------------------------------------------------ */
        .factory('ClipboardService', ['$q', '$window', '$document', function ($q, $window, $document) {

            function legacyCopy(text) {
                var doc = $document[0];
                var area = doc.createElement('textarea');
                area.value = text;
                area.setAttribute('readonly', '');
                area.style.position = 'fixed';
                area.style.top = '0';
                area.style.left = '-9999px';
                doc.body.appendChild(area);
                area.select();
                var ok = false;
                try {
                    ok = doc.execCommand('copy');
                } catch (e) {
                    ok = false;
                }
                doc.body.removeChild(area);
                return ok;
            }

            function copy(text) {
                var deferred = $q.defer();

                function fallback() {
                    if (legacyCopy(text)) {
                        deferred.resolve();
                    } else {
                        deferred.reject();
                    }
                }

                var nav = $window.navigator;
                if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
                    nav.clipboard.writeText(text).then(function () {
                        deferred.resolve();
                    }, fallback);
                } else {
                    fallback();
                }
                return deferred.promise;
            }

            return { copy: copy };
        }])

        /* ------------------------------------------------------------------
         * FileExportService: UTF-8 text download
         * ------------------------------------------------------------------ */
        .factory('FileExportService', ['$window', '$document', function ($window, $document) {
            function downloadText(text, fileName) {
                try {
                    var blob = new $window.Blob([text], { type: 'text/plain;charset=utf-8' });
                    var url = $window.URL.createObjectURL(blob);
                    var doc = $document[0];
                    var link = doc.createElement('a');
                    link.href = url;
                    link.download = fileName;
                    link.style.display = 'none';
                    doc.body.appendChild(link);
                    link.click();
                    doc.body.removeChild(link);
                    $window.setTimeout(function () { $window.URL.revokeObjectURL(url); }, 1000);
                    return true;
                } catch (e) {
                    return false;
                }
            }
            return { downloadText: downloadText };
        }])

        /* ------------------------------------------------------------------
         * QrAccountController: UI state and interactions
         * ------------------------------------------------------------------ */
        .controller('QrAccountController', [
            '$timeout', 'TlvParser', 'AccountMatcher', 'ClipboardService', 'FileExportService',
            function ($timeout, TlvParser, AccountMatcher, ClipboardService, FileExportService) {
                var vm = this;
                var feedbackTimer = null;
                var extraction = null;       // last successful extraction (records)
                var extractedSource = null;  // QR input text that produced it

                vm.maxErrorsShown = MAX_ERRORS_SHOWN;

                vm.qrInput = '';
                vm.targetInput = '';
                vm.extractionOutput = '';
                vm.matchOutput = '';

                vm.extractStats = emptyExtractStats();
                vm.errors = [];
                vm.targetCount = 0;
                vm.matchStats = emptyMatchStats();
                vm.matchRan = false;

                vm.extractMessage = null;
                vm.targetMessage = null;
                vm.matchMessage = null;
                vm.feedback = null;

                function emptyExtractStats() {
                    return {
                        inputRecords: 0,
                        successRecords: 0,
                        accountCount: 0,
                        noAccountRecords: 0,
                        failedRecords: 0
                    };
                }

                function emptyMatchStats() {
                    return { recordCount: 0, uniqueMatchedCount: 0, summary: '' };
                }

                function resetMatching() {
                    vm.matchOutput = '';
                    vm.matchStats = emptyMatchStats();
                    vm.matchRan = false;
                    vm.matchMessage = null;
                }

                function resetExtraction() {
                    extraction = null;
                    extractedSource = null;
                    vm.extractionOutput = '';
                    vm.extractStats = emptyExtractStats();
                    vm.errors = [];
                    vm.extractMessage = null;
                }

                function showFeedback(type, text) {
                    vm.feedback = { type: type, text: text };
                    if (feedbackTimer) {
                        $timeout.cancel(feedbackTimer);
                    }
                    feedbackTimer = $timeout(function () {
                        vm.feedback = null;
                        feedbackTimer = null;
                    }, 3500);
                }

                vm.hasExtraction = function () {
                    return extraction !== null;
                };

                vm.canFindMatches = function () {
                    return extraction !== null && extractedSource === vm.qrInput;
                };

                /* ---- Extraction ---- */

                vm.extract = function () {
                    resetMatching();
                    if (String(vm.qrInput).trim() === '') {
                        resetExtraction();
                        vm.extractMessage = {
                            type: 'error',
                            text: 'Paste QR input in hash[TAB]qrcode format first.'
                        };
                        return;
                    }

                    var source = vm.qrInput;
                    var result = TlvParser.processInput(source);

                    extraction = result.records;
                    extractedSource = source;
                    vm.extractionOutput = result.outputText;
                    vm.extractStats = result.stats;
                    vm.errors = result.errors;

                    if (result.stats.inputRecords > 0 && result.records.length === 0) {
                        vm.extractMessage = {
                            type: 'error',
                            text: 'No valid records found. See the error details below.'
                        };
                    } else if (result.stats.failedRecords > 0) {
                        vm.extractMessage = {
                            type: 'warning',
                            text: 'Extraction finished. ' + result.stats.failedRecords +
                                ' record(s) were malformed and excluded.'
                        };
                    } else {
                        vm.extractMessage = {
                            type: 'success',
                            text: 'Extraction finished for ' + result.records.length + ' record(s).'
                        };
                    }
                };

                vm.onQrInputChange = function () {
                    if (extraction !== null && extractedSource !== vm.qrInput) {
                        resetExtraction();
                        resetMatching();
                        vm.extractMessage = {
                            type: 'warning',
                            text: 'QR input changed. Previous results were cleared; run Extract Accounts again.'
                        };
                    }
                };

                vm.clearInput = function () {
                    vm.qrInput = '';
                    resetExtraction();
                    resetMatching();
                };

                /* ---- Targets and matching ---- */

                vm.onTargetInputChange = function () {
                    vm.targetCount = AccountMatcher.parseTargetAccounts(vm.targetInput).accounts.length;
                    vm.targetMessage = null;
                    if (vm.matchRan || vm.matchOutput !== '') {
                        resetMatching();
                        vm.targetMessage = {
                            type: 'warning',
                            text: 'Target accounts changed. Previous match results were cleared; run Find Matches again.'
                        };
                    }
                };

                vm.findMatches = function () {
                    vm.targetMessage = null;
                    resetMatching();

                    if (!vm.canFindMatches()) {
                        vm.targetMessage = {
                            type: 'error',
                            text: 'Run Extract Accounts on the current QR input before matching.'
                        };
                        return;
                    }

                    var targets = AccountMatcher.parseTargetAccounts(vm.targetInput);
                    vm.targetCount = targets.accounts.length;
                    if (targets.accounts.length === 0) {
                        vm.targetMessage = {
                            type: 'error',
                            text: 'Enter at least one target account (one per line).'
                        };
                        return;
                    }

                    var result = AccountMatcher.matchAccounts(extraction, targets.set);
                    vm.matchOutput = result.outputText;
                    vm.matchRan = true;
                    vm.matchStats = {
                        recordCount: result.recordCount,
                        uniqueMatchedCount: result.uniqueMatchedCount,
                        summary: result.recordCount + ' matching record(s); ' +
                            result.uniqueMatchedCount + ' of ' + targets.accounts.length +
                            ' unique target account(s) found.'
                    };

                    if (result.recordCount === 0) {
                        vm.matchMessage = { type: 'warning', text: 'No matching accounts found' };
                    } else {
                        vm.matchMessage = { type: 'success', text: 'Matching finished.' };
                    }
                };

                vm.clearTargets = function () {
                    vm.targetInput = '';
                    vm.targetCount = 0;
                    vm.targetMessage = null;
                    resetMatching();
                };

                /* ---- Copy and export ---- */

                vm.copyText = function (text, label) {
                    if (!text) {
                        showFeedback('warning', 'Nothing to copy: ' + label + ' is empty.');
                        return;
                    }
                    ClipboardService.copy(text).then(function () {
                        showFeedback('success', label + ' copied to clipboard.');
                    }, function () {
                        showFeedback('error', 'Copy failed. Select the text and copy it manually.');
                    });
                };

                vm.copyExtraction = function () {
                    vm.copyText(vm.extractionOutput, 'Extraction results');
                };

                vm.copyMatches = function () {
                    vm.copyText(vm.matchOutput, 'Matching results');
                };

                vm.exportMatches = function () {
                    if (!vm.matchOutput) {
                        showFeedback('warning', 'Nothing to export: there are no matching results.');
                        return;
                    }
                    if (FileExportService.downloadText(vm.matchOutput, 'matched_hashes.txt')) {
                        showFeedback('success', 'Exported matched_hashes.txt.');
                    } else {
                        showFeedback('error', 'Export failed in this browser.');
                    }
                };
            }
        ]);
})();
