package com.blackline.api.controller;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * The redactor's entire server surface.
 *
 * <p>This service exists for the keep-alive ping on free-tier hosting and as a home
 * for potential future features (e.g. an anonymous usage counter). It has no endpoint
 * that accepts a request body — file bytes cannot reach it even by mistake. All
 * redaction happens in the browser.
 */
@RestController
@RequestMapping("/api")
public class PingController {

    /**
     * Lightweight health endpoint used for keep-alive pinging on free-tier hosting.
     */
    @GetMapping(value = "/ping", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, String> ping() {
        return Map.of("status", "ok", "service", "blackline-api");
    }
}
